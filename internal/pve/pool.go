package pve

import (
	"context"
	"fmt"
	"sync"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/store"
)

type Pool struct {
	store *store.Store
	box   *crypto.Box

	mu      sync.RWMutex
	clients map[string]*Client
}

func NewPool(st *store.Store, box *crypto.Box) *Pool {
	return &Pool{
		store:   st,
		box:     box,
		clients: make(map[string]*Client),
	}
}

func (p *Pool) Invalidate(instanceID string) {
	p.mu.Lock()
	delete(p.clients, instanceID)
	p.mu.Unlock()
}

func (p *Pool) Get(ctx context.Context, instanceID string) (*Client, *store.PVEInstance, error) {
	inst, err := p.store.GetInstance(ctx, instanceID)
	if err != nil {
		return nil, nil, err
	}
	if !inst.Enabled {
		return nil, inst, fmt.Errorf("instance %q is disabled", inst.Name)
	}

	p.mu.RLock()
	cl, ok := p.clients[instanceID]
	p.mu.RUnlock()
	if ok {
		return cl, inst, nil
	}

	cl, err = p.BuildClientFromInstance(inst, true)
	if err != nil {
		return nil, inst, err
	}

	p.mu.Lock()
	p.clients[instanceID] = cl
	p.mu.Unlock()
	return cl, inst, nil
}

func (p *Pool) BuildClientFromInstance(inst *store.PVEInstance, persistTOFU bool) (*Client, error) {
	tokenSecret, err := p.box.DecryptString(inst.TokenSecretEnc)
	if err != nil {
		return nil, fmt.Errorf("decrypt token secret: %w", err)
	}
	ticketPass, err := p.box.DecryptString(inst.TicketPasswordEnc)
	if err != nil {
		return nil, fmt.Errorf("decrypt ticket password: %w", err)
	}

	var eps []EndpointConfig
	for _, ep := range inst.Endpoints {
		eps = append(eps, EndpointConfig{
			ID:              ep.ID,
			URL:             ep.URL,
			Priority:        ep.Priority,
			CertFingerprint: ep.CertFingerprint,
		})
	}

	cfg := ClientConfig{
		InstanceID:     inst.ID,
		AuthMode:       inst.AuthMode,
		TokenID:        inst.TokenID,
		TokenSecret:    tokenSecret,
		TicketUsername: inst.TicketUsername,
		TicketPassword: ticketPass,
		TLSMode:        inst.TLSMode,
		CACertPEM:      inst.CACertPEM,
		Endpoints:      eps,
	}
	if persistTOFU {
		cfg.OnTOFUTrust = func(endpointID, fp string) {
			_ = p.store.UpdateEndpointFingerprint(context.Background(), endpointID, fp)
		}
	}
	return NewClient(cfg)
}
