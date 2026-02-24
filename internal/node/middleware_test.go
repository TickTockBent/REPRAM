package node

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestMiddleware creates a SecurityMiddleware for testing.
// Uses a unique prometheus registry per test to avoid duplicate metric registration.
func newTestMiddleware() *SecurityMiddleware {
	return &SecurityMiddleware{
		rateLimiter:    NewRateLimiter(1000, 1000),
		maxRequestSize: 1024 * 1024,
		metrics:        nil, // skip metrics in tests
	}
}

// isSuspicious is a test helper that creates a request with the given user-agent and URL
// and checks if isSuspiciousRequest flags it.
func isSuspicious(t *testing.T, sm *SecurityMiddleware, userAgent string, url string) bool {
	t.Helper()
	req := httptest.NewRequest("GET", url, nil)
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	return sm.isSuspiciousRequest(req)
}

func TestBlocksKnownScanners(t *testing.T) {
	sm := newTestMiddleware()
	defer sm.Close()

	scanners := []string{
		"sqlmap/1.5",
		"Nikto/2.1.6",
		"Nmap Scripting Engine",
		"masscan/1.3",
		"gobuster/3.1",
		"DirBuster-1.0-RC1",
	}

	for _, ua := range scanners {
		if !isSuspicious(t, sm, ua, "/v1/data/test") {
			t.Errorf("scanner UA %q should be blocked", ua)
		}
	}
}

func TestAllowsLegitimateClients(t *testing.T) {
	sm := newTestMiddleware()
	defer sm.Close()

	legitimateUAs := []string{
		"python-requests/2.28.0",
		"curl/7.88.1",
		"Go-http-client/1.1",
		"node-fetch/1.0",
		"",                // empty UA
		"MyCustomAgent/1", // arbitrary
	}

	for _, ua := range legitimateUAs {
		if isSuspicious(t, sm, ua, "/v1/data/test") {
			t.Errorf("legitimate UA %q should not be blocked", ua)
		}
	}
}

func TestAllowsKeysWithSQLWords(t *testing.T) {
	sm := newTestMiddleware()
	defer sm.Close()

	// These keys contain words that the old URL pattern matcher would have blocked
	legitimateURLs := []string{
		"/v1/data/user_selection",
		"/v1/data/drop_zone",
		"/v1/data/script_output",
		"/v1/data/alert_config",
		"/v1/data/exec_result",
		"/v1/data/delete_queue",
		"/v1/data/union_type",
		"/v1/data/insert_point",
		"/v1/data/select_all",
		"/v1/data/my../path",
		"/v1/data/etc/passwd",
	}

	for _, url := range legitimateURLs {
		if isSuspicious(t, sm, "curl/7.88.1", url) {
			t.Errorf("URL %q should not be blocked — keys are opaque", url)
		}
	}
}

func TestRateLimiterAllowsUnderLimit(t *testing.T) {
	rl := NewRateLimiter(100, 100)
	defer rl.Close()

	for i := 0; i < 50; i++ {
		if !rl.Allow("192.168.1.1") {
			t.Fatalf("request %d should be allowed under rate limit", i)
		}
	}
}

func TestRateLimiterBlocksOverLimit(t *testing.T) {
	rl := NewRateLimiter(10, 10)
	defer rl.Close()

	// Exhaust the bucket
	for i := 0; i < 10; i++ {
		rl.Allow("192.168.1.1")
	}

	// Next request should be blocked
	if rl.Allow("192.168.1.1") {
		t.Fatal("request should be blocked after exhausting rate limit")
	}
}

func TestRateLimiterPerIP(t *testing.T) {
	rl := NewRateLimiter(10, 1)
	defer rl.Close()

	// Exhaust IP 1
	rl.Allow("192.168.1.1")
	if rl.Allow("192.168.1.1") {
		t.Fatal("second request from same IP should be blocked (burst=1)")
	}

	// Different IP should still be allowed
	if !rl.Allow("192.168.1.2") {
		t.Fatal("first request from different IP should be allowed")
	}
}

func TestGetClientIPFromXForwardedFor(t *testing.T) {
	sm := newTestMiddleware()
	defer sm.Close()

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-For", "10.0.0.1, 10.0.0.2")

	ip := sm.getClientIP(req)
	if ip != "10.0.0.1" {
		t.Fatalf("getClientIP = %q, want %q", ip, "10.0.0.1")
	}
}

func TestGetClientIPFromXRealIP(t *testing.T) {
	sm := newTestMiddleware()
	defer sm.Close()

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Real-IP", "10.0.0.5")

	ip := sm.getClientIP(req)
	if ip != "10.0.0.5" {
		t.Fatalf("getClientIP = %q, want %q", ip, "10.0.0.5")
	}
}

func TestGetClientIPFallsBackToRemoteAddr(t *testing.T) {
	sm := newTestMiddleware()
	defer sm.Close()

	req := httptest.NewRequest("GET", "/", nil)
	// httptest.NewRequest sets RemoteAddr to "192.0.2.1:1234"

	ip := sm.getClientIP(req)
	if ip != "192.0.2.1" {
		t.Fatalf("getClientIP = %q, want %q", ip, "192.0.2.1")
	}
}

func TestSecurityHeaders(t *testing.T) {
	sm := newTestMiddleware()
	defer sm.Close()

	rec := httptest.NewRecorder()
	sm.applySecurityHeaders(rec)

	expected := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":       "DENY",
		"X-XSS-Protection":      "1; mode=block",
		"X-REPRAM-Node":         "1.0.0",
	}

	for header, want := range expected {
		got := rec.Header().Get(header)
		if got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
}

func TestMaxRequestSizeMiddleware(t *testing.T) {
	handler := MaxRequestSizeMiddleware(100)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Request within limit
	req := httptest.NewRequest("POST", "/", nil)
	req.ContentLength = 50
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("request within limit returned %d, want 200", rec.Code)
	}

	// Request over limit
	req = httptest.NewRequest("POST", "/", nil)
	req.ContentLength = 200
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request returned %d, want 413", rec.Code)
	}
}
