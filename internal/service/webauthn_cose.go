package service

import (
	stdcrypto "crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
)

// Pure-Go bounded RFC 8949 CBOR & RFC 9052 COSE_Key verifier for WebAuthn Level 2/3 Passkeys.
// Supports ES256 (P-256), ES384 (P-384), EdDSA (Ed25519), and RS256, plus synced passkeys
// (macOS Touch ID / iCloud Keychain, Bitwarden Passkey, 1Password, Google Password Manager).

const maxCBORInputLen = 64 * 1024

func decodeCBORItem(data []byte, depth int) (any, int, error) {
	if depth > 8 {
		return nil, 0, errors.New("CBOR nesting depth exceeded")
	}
	if len(data) == 0 {
		return nil, 0, errors.New("unexpected end of CBOR data")
	}
	if len(data) > maxCBORInputLen {
		return nil, 0, errors.New("CBOR input exceeds size limit")
	}

	major := data[0] >> 5
	ai := data[0] & 0x1f
	if ai == 31 {
		return nil, 0, errors.New("indefinite-length CBOR items are not supported")
	}

	var arg uint64
	pos := 1
	switch {
	case ai < 24:
		arg = uint64(ai)
	case ai == 24:
		if len(data) < pos+1 {
			return nil, 0, errors.New("truncated 1-byte CBOR argument")
		}
		arg = uint64(data[pos])
		pos++
	case ai == 25:
		if len(data) < pos+2 {
			return nil, 0, errors.New("truncated 2-byte CBOR argument")
		}
		arg = uint64(binary.BigEndian.Uint16(data[pos : pos+2]))
		pos += 2
	case ai == 26:
		if len(data) < pos+4 {
			return nil, 0, errors.New("truncated 4-byte CBOR argument")
		}
		arg = uint64(binary.BigEndian.Uint32(data[pos : pos+4]))
		pos += 4
	case ai == 27:
		if len(data) < pos+8 {
			return nil, 0, errors.New("truncated 8-byte CBOR argument")
		}
		arg = binary.BigEndian.Uint64(data[pos : pos+8])
		pos += 8
	default:
		return nil, 0, errors.New("invalid CBOR additional information")
	}

	switch major {
	case 0: // Unsigned integer
		if arg > uint64(^uint64(0)>>1) {
			return arg, pos, nil
		}
		return int64(arg), pos, nil
	case 1: // Negative integer (-1 - arg)
		if arg > uint64(^uint64(0)>>1) {
			return nil, 0, errors.New("CBOR negative integer overflow")
		}
		return -1 - int64(arg), pos, nil
	case 2: // Byte string
		if arg > uint64(len(data)-pos) {
			return nil, 0, errors.New("truncated CBOR byte string")
		}
		n := int(arg)
		cp := make([]byte, n)
		copy(cp, data[pos:pos+n])
		return cp, pos + n, nil
	case 3: // Text string
		if arg > uint64(len(data)-pos) {
			return nil, 0, errors.New("truncated CBOR text string")
		}
		n := int(arg)
		return string(data[pos : pos+n]), pos + n, nil
	case 4: // Array
		if arg > 1024 {
			return nil, 0, errors.New("CBOR array too large")
		}
		arr := make([]any, int(arg))
		for i := 0; i < int(arg); i++ {
			v, consumed, err := decodeCBORItem(data[pos:], depth+1)
			if err != nil {
				return nil, 0, err
			}
			arr[i] = v
			pos += consumed
		}
		return arr, pos, nil
	case 5: // Map (preserve string or int64 keys cleanly)
		if arg > 1024 {
			return nil, 0, errors.New("CBOR map too large")
		}
		m := make(map[any]any, int(arg))
		for i := 0; i < int(arg); i++ {
			k, kc, err := decodeCBORItem(data[pos:], depth+1)
			if err != nil {
				return nil, 0, err
			}
			pos += kc
			switch k.(type) {
			case string, int64, uint64, bool:
			default:
				k = fmt.Sprintf("%v", k)
			}
			v, vc, err := decodeCBORItem(data[pos:], depth+1)
			if err != nil {
				return nil, 0, err
			}
			pos += vc
			m[k] = v
		}
		return m, pos, nil
	case 7: // Simple / Booleans / Null
		switch ai {
		case 20:
			return false, pos, nil
		case 21:
			return true, pos, nil
		case 22, 23:
			return nil, pos, nil
		default:
			return arg, pos, nil
		}
	default:
		return nil, 0, fmt.Errorf("unsupported CBOR major type %d", major)
	}
}

type parsedAttestationAuthData struct {
	RPIDHash        [32]byte
	Flags           byte
	UserPresent     bool
	UserVerified    bool
	BackupEligible  bool
	BackupState     bool
	SignCount       uint32
	AAGUID          string
	CredentialID    []byte
	PublicKeyCBOR   []byte
	AttestationType string
}

func formatAAGUID(b []byte) string {
	if len(b) != 16 {
		return ""
	}
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

func parseWebAuthnAttestationObject(rawAttestation []byte) (*parsedAttestationAuthData, error) {
	val, _, err := decodeCBORItem(rawAttestation, 0)
	if err != nil {
		return nil, fmt.Errorf("decode attestationObject: %w", err)
	}
	topMap, ok := val.(map[any]any)
	if !ok {
		return nil, errors.New("attestationObject must be a CBOR map")
	}
	authData, ok := topMap["authData"].([]byte)
	if !ok || len(authData) < 55 {
		return nil, errors.New("attestationObject missing valid authData")
	}
	attFmt, _ := topMap["fmt"].(string)
	if attFmt == "" {
		attFmt = "none"
	}

	out := &parsedAttestationAuthData{
		Flags:           authData[32],
		UserPresent:     (authData[32] & 0x01) != 0,
		UserVerified:    (authData[32] & 0x04) != 0,
		BackupEligible:  (authData[32] & 0x08) != 0,
		BackupState:     (authData[32] & 0x10) != 0,
		SignCount:       binary.BigEndian.Uint32(authData[33:37]),
		AttestationType: attFmt,
	}
	copy(out.RPIDHash[:], authData[0:32])

	// W3C WebAuthn L3 §6.1: BS must not be set if BE is 0
	if !out.BackupEligible && out.BackupState {
		return nil, errors.New("invalid authenticator flags: BS=1 while BE=0")
	}
	if (authData[32] & 0x40) == 0 {
		return nil, errors.New("registration authenticatorData missing AT (attested credential data) flag")
	}

	out.AAGUID = formatAAGUID(authData[37:53])
	credIDLen := int(binary.BigEndian.Uint16(authData[53:55]))
	if credIDLen <= 0 || credIDLen > 1023 || len(authData) < 55+credIDLen+1 {
		return nil, errors.New("invalid WebAuthn credential ID length")
	}
	out.CredentialID = make([]byte, credIDLen)
	copy(out.CredentialID, authData[55:55+credIDLen])

	// Decode exactly the COSE_Key CBOR map so any trailing ED (0x80) extension map is cleanly ignored
	rest := authData[55+credIDLen:]
	_, coseLen, err := decodeCBORItem(rest, 0)
	if err != nil {
		return nil, fmt.Errorf("decode credentialPublicKey: %w", err)
	}
	out.PublicKeyCBOR = make([]byte, coseLen)
	copy(out.PublicKeyCBOR, rest[:coseLen])

	if _, _, err := parseCOSEPublicKey(out.PublicKeyCBOR); err != nil {
		return nil, err
	}
	return out, nil
}

func parseCOSEPublicKey(coseBytes []byte) (int64, stdcrypto.PublicKey, error) {
	item, _, err := decodeCBORItem(coseBytes, 0)
	if err != nil {
		return 0, nil, fmt.Errorf("decode COSE key: %w", err)
	}
	m, ok := item.(map[any]any)
	if !ok {
		return 0, nil, errors.New("COSE key is not a CBOR map")
	}

	kty, ok1 := m[int64(1)].(int64)
	alg, ok2 := m[int64(3)].(int64)
	if !ok1 || !ok2 {
		return 0, nil, errors.New("COSE key missing kty or alg")
	}

	switch {
	case kty == 2 && (alg == -7 || alg == -35): // EC2: ES256 (P-256) or ES384 (P-384)
		crv, _ := m[int64(-1)].(int64)
		xBytes, okX := m[int64(-2)].([]byte)
		yBytes, okY := m[int64(-3)].([]byte)
		if !okX || !okY {
			return 0, nil, errors.New("EC2 COSE key missing x or y coordinate")
		}
		if alg == -7 {
			if crv != 1 || len(xBytes) != 32 || len(yBytes) != 32 {
				return 0, nil, errors.New("ES256 COSE key must use P-256 with 32-byte coordinates")
			}
			uncompressed := make([]byte, 65)
			uncompressed[0] = 0x04
			copy(uncompressed[1:33], xBytes)
			copy(uncompressed[33:65], yBytes)
			if _, err := ecdh.P256().NewPublicKey(uncompressed); err != nil {
				return 0, nil, fmt.Errorf("invalid P-256 public key point: %w", err)
			}
			return alg, &ecdsa.PublicKey{
				Curve: elliptic.P256(),
				X:     new(big.Int).SetBytes(xBytes),
				Y:     new(big.Int).SetBytes(yBytes),
			}, nil
		}
		if crv != 2 || len(xBytes) != 48 || len(yBytes) != 48 {
			return 0, nil, errors.New("ES384 COSE key must use P-384 with 48-byte coordinates")
		}
		uncompressed := make([]byte, 97)
		uncompressed[0] = 0x04
		copy(uncompressed[1:49], xBytes)
		copy(uncompressed[49:97], yBytes)
		if _, err := ecdh.P384().NewPublicKey(uncompressed); err != nil {
			return 0, nil, fmt.Errorf("invalid P-384 public key point: %w", err)
		}
		return alg, &ecdsa.PublicKey{
			Curve: elliptic.P384(),
			X:     new(big.Int).SetBytes(xBytes),
			Y:     new(big.Int).SetBytes(yBytes),
		}, nil

	case kty == 1 && alg == -8: // OKP: EdDSA (Ed25519)
		crv, _ := m[int64(-1)].(int64)
		xBytes, okX := m[int64(-2)].([]byte)
		if crv != 6 || !okX || len(xBytes) != ed25519.PublicKeySize {
			return 0, nil, errors.New("EdDSA COSE key must use Ed25519 (32 bytes)")
		}
		return alg, ed25519.PublicKey(xBytes), nil

	case kty == 3 && alg == -257: // RSA: RS256
		nBytes, okN := m[int64(-1)].([]byte)
		eBytes, okE := m[int64(-2)].([]byte)
		if !okN || !okE || len(nBytes) < 256 || len(eBytes) == 0 || len(eBytes) > 8 {
			return 0, nil, errors.New("RS256 COSE key requires >= 2048-bit modulus and valid exponent")
		}
		eInt := new(big.Int).SetBytes(eBytes)
		if !eInt.IsInt64() || eInt.Int64() < 3 || eInt.Bit(0) == 0 {
			return 0, nil, errors.New("invalid RSA public exponent")
		}
		return alg, &rsa.PublicKey{
			N: new(big.Int).SetBytes(nBytes),
			E: int(eInt.Int64()),
		}, nil

	default:
		return 0, nil, fmt.Errorf("unsupported COSE key type/algorithm (kty=%d, alg=%d)", kty, alg)
	}
}

func verifyWebAuthnAssertionSignature(coseKeyBytes, authData, clientDataJSON, sig []byte) error {
	alg, pub, err := parseCOSEPublicKey(coseKeyBytes)
	if err != nil {
		return err
	}
	clientHash := sha256.Sum256(clientDataJSON)
	signed := make([]byte, len(authData)+len(clientHash))
	copy(signed, authData)
	copy(signed[len(authData):], clientHash[:])

	switch alg {
	case -7: // ES256
		digest := sha256.Sum256(signed)
		if !ecdsa.VerifyASN1(pub.(*ecdsa.PublicKey), digest[:], sig) {
			return errors.New("ES256 signature verification failed")
		}
		return nil
	case -35: // ES384
		digest := sha512.Sum384(signed)
		if !ecdsa.VerifyASN1(pub.(*ecdsa.PublicKey), digest[:], sig) {
			return errors.New("ES384 signature verification failed")
		}
		return nil
	case -8: // EdDSA
		if !ed25519.Verify(pub.(ed25519.PublicKey), signed, sig) {
			return errors.New("EdDSA signature verification failed")
		}
		return nil
	case -257: // RS256
		digest := sha256.Sum256(signed)
		if err := rsa.VerifyPKCS1v15(pub.(*rsa.PublicKey), stdcrypto.SHA256, digest[:], sig); err != nil {
			return errors.New("RS256 signature verification failed")
		}
		return nil
	default:
		return fmt.Errorf("unsupported WebAuthn signature algorithm %d", alg)
	}
}
