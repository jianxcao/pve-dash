package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jianxcao/pve-dash/internal/api"
	"github.com/jianxcao/pve-dash/internal/config"
	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/jianxcao/pve-dash/web"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("load config failed", "err", err)
		os.Exit(1)
	}

	box, err := crypto.NewBox(cfg.MasterKey)
	if err != nil {
		slog.Error("init crypto box failed", "err", err)
		os.Exit(1)
	}

	st, err := store.OpenSQLite(cfg.DBPath)
	if err != nil {
		slog.Error("open sqlite failed", "path", cfg.DBPath, "err", err)
		os.Exit(1)
	}
	defer st.Close()

	authSvc := service.NewAuthService(st, cfg.JWTSecret)
	pool := pve.NewPool(st, box)
	aggSvc := service.NewAggregatorService(st, pool)
	alertEngine := service.NewAlertEngine(st, box, pool, aggSvc)
	consoleMgr := pve.NewConsoleManager(pool)

	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()
	alertEngine.Start(bgCtx)

	srv := api.NewServer(cfg, st, box, authSvc, pool, aggSvc, alertEngine, consoleMgr, web.DistFS(), bgCtx)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("PVE Dash server listening", "addr", cfg.ListenAddr, "db", cfg.DBPath)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		slog.Error("server error", "err", err)
		bgCancel()
		consoleMgr.Stop()
		alertEngine.Wait()
		pool.Close()
		os.Exit(1)
	case sig := <-sigCh:
		slog.Info("shutting down", "signal", sig.String())
		// Cancel SSE/WS streams and alert loop first so Shutdown doesn't wait full 10s
		bgCancel()
		consoleMgr.Stop()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
		alertEngine.Wait()
		pool.Close()
	}
}
