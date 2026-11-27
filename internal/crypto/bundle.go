package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/argon2"
)

const (
	BackupBundleFormat  = "pve-dash-backup"
	BackupBundleVersion = 1
	backupBundleAAD     = "pve-dash-backup:v1"
)

// EncryptedBundle holds a passphrase-protected portable configuration backup.
type EncryptedBundle struct {
	Format     string `json:"format"`
	Version    int    `json:"version"`
	ExportedAt string `json:"exportedAt"`
	KDF        string `json:"kdf"`
	KDFTime    uint32 `json:"kdfTime"`
	KDFMemory  uint32 `json:"kdfMemory"`
	KDFThreads uint8  `json:"kdfThreads"`
	Salt       string `json:"salt"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

func EncryptBundleWithPassphrase(plaintext []byte, passphrase string) (*EncryptedBundle, error) {
	if len(passphrase) < 8 {
		return nil, errors.New("加密口令至少需要 8 个字符")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	argonSem <- struct{}{}
	key := argon2.IDKey([]byte(passphrase), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	<-argonSem
	defer clear(key)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ct := aead.Seal(nil, nonce, plaintext, []byte(backupBundleAAD))

	return &EncryptedBundle{
		Format:     BackupBundleFormat,
		Version:    BackupBundleVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		KDF:        "argon2id",
		KDFTime:    argonTime,
		KDFMemory:  argonMemory,
		KDFThreads: argonThreads,
		Salt:       base64.RawStdEncoding.EncodeToString(salt),
		Nonce:      base64.RawStdEncoding.EncodeToString(nonce),
		Ciphertext: base64.RawStdEncoding.EncodeToString(ct),
	}, nil
}

func DecryptBundleWithPassphrase(b *EncryptedBundle, passphrase string) ([]byte, error) {
	if b == nil {
		return nil, errors.New("备份文件为空")
	}
	if b.Format != BackupBundleFormat {
		return nil, fmt.Errorf("不支持的备份格式 %q（需为 %s）", b.Format, BackupBundleFormat)
	}
	if b.Version != BackupBundleVersion {
		return nil, fmt.Errorf("不支持的备份版本 %d", b.Version)
	}
	if b.KDF != "argon2id" {
		return nil, fmt.Errorf("不支持的密钥派生算法 %q", b.KDF)
	}
	if b.KDFTime < 1 || b.KDFTime > 6 || b.KDFMemory < 8*1024 || b.KDFMemory > 128*1024 || b.KDFThreads < 1 || b.KDFThreads > 8 {
		return nil, errors.New("备份文件的 KDF 参数超出安全范围")
	}
	if passphrase == "" {
		return nil, errors.New("请提供解密口令")
	}
	salt, err := base64.RawStdEncoding.DecodeString(b.Salt)
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return nil, errors.New("备份文件 Salt 损坏")
	}
	nonce, err := base64.RawStdEncoding.DecodeString(b.Nonce)
	if err != nil || len(nonce) != 12 {
		return nil, errors.New("备份文件 Nonce 损坏")
	}
	ct, err := base64.RawStdEncoding.DecodeString(b.Ciphertext)
	if err != nil || len(ct) < 16 {
		return nil, errors.New("备份文件密文损坏")
	}

	argonSem <- struct{}{}
	key := argon2.IDKey([]byte(passphrase), salt, b.KDFTime, b.KDFMemory, b.KDFThreads, argonKeyLen)
	<-argonSem
	defer clear(key)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := aead.Open(nil, nonce, ct, []byte(backupBundleAAD))
	if err != nil {
		return nil, errors.New("解密失败：口令错误或备份文件已被篡改")
	}
	return plain, nil
}
