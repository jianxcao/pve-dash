package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestUserRBACLastAdminAndTokenVersion(t *testing.T) {
	st, err := OpenSQLite(filepath.Join(t.TempDir(), "users.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	admin := &User{
		ID:           "u-admin",
		Username:     "admin",
		DisplayName:  "Admin",
		PasswordHash: "h1",
		Role:         "admin",
		IsActive:     true,
	}
	if err := st.CreateFirstAdmin(ctx, admin); err != nil {
		t.Fatal(err)
	}

	// Duplicate username rejected
	dup := &User{ID: "u-dup", Username: "admin", DisplayName: "Dup", PasswordHash: "h", Role: "viewer", IsActive: true}
	if err := st.CreateUserUnique(ctx, dup); !errors.Is(err, ErrDuplicateUsername) {
		t.Fatalf("expected ErrDuplicateUsername, got %v", err)
	}

	// Last active admin cannot be demoted, disabled, or deleted
	if _, err := st.UpdateUser(ctx, "u-admin", "Admin", "operator", true, ""); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("expected ErrLastAdmin on demote, got %v", err)
	}
	if _, err := st.UpdateUser(ctx, "u-admin", "Admin", "admin", false, ""); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("expected ErrLastAdmin on disable, got %v", err)
	}
	if err := st.DeleteUser(ctx, "u-admin"); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("expected ErrLastAdmin on delete, got %v", err)
	}

	// Add viewer, bump token version via RevokeUserSessions and UpdateUserPassword
	viewer := &User{ID: "u-view", Username: "viewer1", DisplayName: "Viewer", PasswordHash: "h2", Role: "viewer", IsActive: true}
	if err := st.CreateUserUnique(ctx, viewer); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RevokeUserSessions(ctx, "u-view"); err != nil {
		t.Fatal(err)
	}
	gotV, err := st.GetUserByID(ctx, "u-view")
	if err != nil {
		t.Fatal(err)
	}
	if gotV.TokenVersion != 2 {
		t.Fatalf("expected TokenVersion=2 after revoke, got %d", gotV.TokenVersion)
	}

	updatedV, err := st.UpdateUserPassword(ctx, "u-view", "h3")
	if err != nil {
		t.Fatal(err)
	}
	if updatedV.TokenVersion != 3 {
		t.Fatalf("expected TokenVersion=3 after password change, got %d", updatedV.TokenVersion)
	}

	list, err := st.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 users, got %d", len(list))
	}
}
