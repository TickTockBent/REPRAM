package gossip

import "testing"

func TestSignAndVerify(t *testing.T) {
	secret := "test-secret-key"
	body := []byte(`{"type":"PUT","from":"node-1","key":"test"}`)

	sig := SignBody(secret, body)
	if sig == "" {
		t.Fatal("SignBody returned empty signature")
	}

	if !VerifyBody(secret, body, sig) {
		t.Fatal("VerifyBody rejected valid signature")
	}
}

func TestVerifyRejectsWrongSecret(t *testing.T) {
	body := []byte(`{"type":"PUT","from":"node-1","key":"test"}`)
	sig := SignBody("secret-a", body)

	if VerifyBody("secret-b", body, sig) {
		t.Fatal("VerifyBody accepted signature from wrong secret")
	}
}

func TestVerifyRejectsTamperedBody(t *testing.T) {
	secret := "test-secret"
	original := []byte(`{"type":"PUT","from":"node-1","key":"test"}`)
	tampered := []byte(`{"type":"PUT","from":"node-1","key":"evil"}`)

	sig := SignBody(secret, original)

	if VerifyBody(secret, tampered, sig) {
		t.Fatal("VerifyBody accepted signature for tampered body")
	}
}

func TestVerifyRejectsEmptySignature(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"type":"PUT"}`)

	if VerifyBody(secret, body, "") {
		t.Fatal("VerifyBody accepted empty signature")
	}
}

func TestVerifyRejectsGarbageSignature(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"type":"PUT"}`)

	if VerifyBody(secret, body, "not-a-real-signature") {
		t.Fatal("VerifyBody accepted garbage signature")
	}
}
