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
	inst      *store.PVEInstance
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

func cloneInstance(in *store.PVEInstance) *store.PVEInstance {
	if in == nil {
		return nil
	}
	cp := *in
	if in.TokenSecretEnc != nil {
		cp.TokenSecretEnc = append([]byte(nil), in.TokenSecretEnc...)
	}
	if in.TicketPasswordEnc != nil {
		cp.TicketPasswordEnc = append([]byte(nil), in.TicketPasswordEnc...)
	}
	if in.Endpoints != nil {
		cp.Endpoints = make([]store.PVEEndpoint, len(in.Endpoints))
		copy(cp.Endpoints, in.Endpoints)
	} else {
		cp.Endpoints = []store.PVEEndpoint{}
	}
	return &cp
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

// Close closes all cached PVE HTTP clients and clears the pool.
func (p *Pool) Close() {
	p.mu.Lock()
	toClose := make([]*Client, 0, len(p.clients))
	for id, c := range p.clients {
		p.gens[id]++
		if c.client != nil {
			toClose = append(toClose, c.client)
		}
		delete(p.clients, id)
	}
	p.mu.Unlock()
	for _, cl := range toClose {
		cl.Close()
	}
}

func (p *Pool) Get(ctx context.Context, instanceID string) (*Client, *store.PVEInstance, error) {
	for attempt := 0; attempt < 4; attempt++ {
		p.mu.RLock()
		genBefore := p.gens[instanceID]
		cached, ok := p.clients[instanceID]
		p.mu.RUnlock()
		if ok && cached.gen == genBefore && cached.client != nil && cached.inst != nil {
			return cached.client, cloneInstance(cached.inst), nil
		}

		inst, err := p.store.GetInstance(ctx, instanceID)
		if err != nil {
			return nil, nil, err
		}
		if !inst.Enabled {
			return nil, inst, fmt.Errorf("instance %q is disabled", inst.Name)
		}

		p.mu.RLock()
		cached, ok = p.clients[instanceID]
		curGen := p.gens[instanceID]
		p.mu.RUnlock()
		if ok && cached.updatedAt == inst.UpdatedAt && cached.gen == curGen && cached.client != nil && cached.inst != nil {
			return cached.client, cloneInstance(cached.inst), nil
		}

		cl, err := p.BuildClientFromInstance(inst, true)
		if err != nil {
			return nil, inst, err
		}

		p.mu.Lock()
		if p.gens[instanceID] != genBefore {
			p.mu.Unlock()
			cl.Close()
			continue
		}
		if existing, exists := p.clients[instanceID]; exists && existing.updatedAt == inst.UpdatedAt && existing.gen == p.gens[instanceID] && existing.client != nil && existing.inst != nil {
			instCopy := cloneInstance(existing.inst)
			p.mu.Unlock()
			cl.Close()
			return existing.client, instCopy, nil
		}
		prev := p.clients[instanceID].client
		p.clients[instanceID] = cachedClient{
			client:    cl,
			inst:      cloneInstance(inst),
			updatedAt: inst.UpdatedAt,
			gen:       genBefore,
		}
		p.mu.Unlock()
		if prev != nil {
			prev.Close()
		}
		return cl, cloneInstance(inst), nil
	}

	// Final non-caching fallback if invalidated continuously in a tight loop: caller still gets a valid instance error/retry.
	return nil, nil, fmt.Errorf("pool contended during concurrent invalidation for instance %q", instanceID)
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
		instID := inst.ID
		cfg.OnTOFUTrust = func(endpointID, fp string) {
			_ = p.store.UpdateEndpointFingerprint(context.Background(), endpointID, fp)
			p.mu.Lock()
			if c, ok := p.clients[instID]; ok && c.inst != nil {
				for i := range c.inst.Endpoints {
					if c.inst.Endpoints[i].ID == endpointID {
						c.inst.Endpoints[i].CertFingerprint = fp
					}
				}
			}
			p.mu.Unlock()
		}
	}
	return NewClient(cfg)
}
