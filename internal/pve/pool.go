package pve

import (
	"context"
	"fmt"
	"sync"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/store"
)

type cachedClient struct {
	client    *Client
	updatedAt string
	gen       uint64
}

type Pool struct {
	store *store.Store
	box   *crypto.Box

	mu      sync.RWMutex
	clients map[string]cachedClient
	gens    map[string]uint64
}

func NewPool(st *store.Store, box *crypto.Box) *Pool {
	return &Pool{
		store:   st,
		box:     box,
		clients: make(map[string]cachedClient),
		gens:    make(map[string]uint64),
	}
}

func (p *Pool) Invalidate(instanceID string) {
	p.mu.Lock()
	p.gens[instanceID]++
	prev, ok := p.clients[instanceID]
	delete(p.clients, instanceID)
	p.mu.Unlock()
	if ok && prev.client != nil {
		prev.client.Close()
	}
}

func (p *Pool) Get(ctx context.Context, instanceID string) (*Client, *store.PVEInstance, error) {
	p.mu.RLock()
	genBefore := p.gens[instanceID]
	p.mu.RUnlock()

	inst, err := p.store.GetInstance(ctx, instanceID)
	if err != nil {
		return nil, nil, err
	}
	if !inst.Enabled {
		return nil, inst, fmt.Errorf("instance %q is disabled", inst.Name)
	}

	p.mu.RLock()
	cached, ok := p.clients[instanceID]
	curGen := p.gens[instanceID]
	p.mu.RUnlock()
	if ok && cached.updatedAt == inst.UpdatedAt && cached.gen == curGen {
		return cached.client, inst, nil
	}

	cl, err := p.BuildClientFromInstance(inst, true)
	if err != nil {
		return nil, inst, err
	}

	p.mu.Lock()
	// Check if another goroutine already cached a fresh client or invalidated while we built
	if p.gens[instanceID] != genBefore {
		p.mu.Unlock()
		return cl, inst, nil
	}
	if existing, exists := p.clients[instanceID]; exists && existing.updatedAt == inst.UpdatedAt && existing.gen == p.gens[instanceID] {
		p.mu.Unlock()
		cl.Close()
		return existing.client, inst, nil
	}
	prev := p.clients[instanceID].client
	p.clients[instanceID] = cachedClient{client: cl, updatedAt: inst.UpdatedAt, gen: genBefore}
	p.mu.Unlock()
	if prev != nil {
		prev.Close()
	}
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
