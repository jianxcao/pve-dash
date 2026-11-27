package crypto

import (
	"sync"
	"testing"
)

func TestBoxEncryptDecrypt(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	box, err := NewBox(key)
	if err != nil {
		t.Fatalf("NewBox: %v", err)
	}
	ct, err := box.EncryptString("super-secret-token")
	if err != nil {
		t.Fatalf("EncryptString: %v", err)
	}
	pt, err := box.DecryptString(ct)
	if err != nil || pt != "super-secret-token" {
		t.Fatalf("DecryptString got (%q, %v)", pt, err)
	}
	if _, err := box.DecryptString([]byte("short")); err == nil {
		t.Fatal("expected error for short ciphertext")
	}
}

func TestArgon2HashVerifyAndParamBounds(t *testing.T) {
	hash, err := HashPassword("my-strong-pass-123")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !VerifyPassword("my-strong-pass-123", hash) {
		t.Fatal("expected valid password to verify")
	}
	if VerifyPassword("wrong-pass", hash) {
		t.Fatal("expected wrong password to fail")
	}
	// Crafted absurd memory cost must be rejected instead of OOMing
	if VerifyPassword("x", "argon2id$2$999999999$2$AAAA$AAAA") {
		t.Fatal("expected out-of-bounds memory cost to be rejected")
	}

	// Concurrent verification must be race-free under semaphore
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !VerifyPassword("my-strong-pass-123", hash) {
				t.Error("concurrent verify failed")
			}
		}()
	}
	wg.Wait()
}
