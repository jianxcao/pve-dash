package crypto

import (
	"bytes"
	"testing"
)

func TestEncryptedBundleRoundTripAndTamperRejection(t *testing.T) {
	payload := []byte(`{"instances":[{"name":"cluster-a","tokenSecret":"super-secret"}]}`)
	bundle, err := EncryptBundleWithPassphrase(payload, "correct-horse-battery")
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}
	if bundle.Format != BackupBundleFormat || bundle.Version != BackupBundleVersion || bundle.KDF != "argon2id" {
		t.Fatalf("unexpected bundle metadata: %+v", bundle)
	}

	got, err := DecryptBundleWithPassphrase(bundle, "correct-horse-battery")
	if err != nil {
		t.Fatalf("decrypt failed: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("decrypted mismatch: got %q want %q", got, payload)
	}

	// Wrong passphrase fails
	if _, err := DecryptBundleWithPassphrase(bundle, "wrong-passphrase"); err == nil {
		t.Fatal("expected decrypt with wrong passphrase to fail")
	}

	// Short passphrase fails on encrypt
	if _, err := EncryptBundleWithPassphrase(payload, "short"); err == nil {
		t.Fatal("expected short passphrase rejected")
	}

	// Tampered ciphertext fails
	tampered := *bundle
	tampered.Ciphertext = "AAAA" + tampered.Ciphertext[4:]
	if _, err := DecryptBundleWithPassphrase(&tampered, "correct-horse-battery"); err == nil {
		t.Fatal("expected tampered ciphertext to fail")
	}
}
