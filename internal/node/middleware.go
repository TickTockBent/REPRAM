package node

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// RateLimiter implements a simple token bucket rate limiter per IP
type RateLimiter struct {
	buckets map[string]*tokenBucket
	mutex   sync.RWMutex
	rate    int           // requests per second
	burst   int           // max burst size
	cleanup chan struct{}
}

type tokenBucket struct {
	tokens    int
	lastRefill time.Time
	mutex     sync.Mutex
}

func NewRateLimiter(rate, burst int) *RateLimiter {
	rl := &RateLimiter{
		buckets: make(map[string]*tokenBucket),
		rate:    rate,
		burst:   burst,
		cleanup: make(chan struct{}),
	}
	
	go rl.cleanupStaleEntries()
	return rl
}

func (rl *RateLimiter) Allow(ip string) bool {
	rl.mutex.Lock()
	bucket, exists := rl.buckets[ip]
	if !exists {
		bucket = &tokenBucket{
			tokens:     rl.burst,
			lastRefill: time.Now(),
		}
		rl.buckets[ip] = bucket
	}
	rl.mutex.Unlock()
	
	bucket.mutex.Lock()
	defer bucket.mutex.Unlock()
	
	// Refill tokens based on time elapsed
	now := time.Now()
	elapsed := now.Sub(bucket.lastRefill)
	tokensToAdd := int(elapsed.Seconds() * float64(rl.rate))
	
	if tokensToAdd > 0 {
		bucket.tokens += tokensToAdd
		if bucket.tokens > rl.burst {
			bucket.tokens = rl.burst
		}
		bucket.lastRefill = now
	}
	
	if bucket.tokens > 0 {
		bucket.tokens--
		return true
	}
	
	return false
}

func (rl *RateLimiter) cleanupStaleEntries() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			rl.mutex.Lock()
			cutoff := time.Now().Add(-10 * time.Minute)
			for ip, bucket := range rl.buckets {
				bucket.mutex.Lock()
				if bucket.lastRefill.Before(cutoff) {
					delete(rl.buckets, ip)
				}
				bucket.mutex.Unlock()
			}
			rl.mutex.Unlock()
		case <-rl.cleanup:
			return
		}
	}
}

func (rl *RateLimiter) Close() {
	close(rl.cleanup)
}

// SecurityMiddleware provides various security features
type SecurityMiddleware struct {
	rateLimiter    *RateLimiter
	maxRequestSize int64
	metrics        *SecurityMetrics
}

type SecurityMetrics struct {
	rateLimitedRequests   prometheus.Counter
	oversizedRequests     prometheus.Counter
	suspiciousRequests    prometheus.Counter
}

func NewSecurityMiddleware(rateLimit, burst int, maxRequestSize int64) *SecurityMiddleware {
	metrics := &SecurityMetrics{
		rateLimitedRequests: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "repram_rate_limited_requests_total",
			Help: "Total number of rate-limited requests",
		}),
		oversizedRequests: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "repram_oversized_requests_total",
			Help: "Total number of oversized requests rejected",
		}),
		suspiciousRequests: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "repram_suspicious_requests_total",
			Help: "Total number of suspicious requests detected",
		}),
	}
	
	prometheus.MustRegister(
		metrics.rateLimitedRequests,
		metrics.oversizedRequests,
		metrics.suspiciousRequests,
	)
	
	return &SecurityMiddleware{
		rateLimiter:    NewRateLimiter(rateLimit, burst),
		maxRequestSize: maxRequestSize,
		metrics:        metrics,
	}
}

func (sm *SecurityMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Apply security headers
		sm.applySecurityHeaders(w)
		
		// Check rate limiting
		clientIP := sm.getClientIP(r)
		if !sm.rateLimiter.Allow(clientIP) {
			sm.metrics.rateLimitedRequests.Inc()
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		
		// Check request size
		if r.ContentLength > sm.maxRequestSize {
			sm.metrics.oversizedRequests.Inc()
			http.Error(w, "Request too large", http.StatusRequestEntityTooLarge)
			return
		}
		
		// Check for suspicious patterns
		if sm.isSuspiciousRequest(r) {
			sm.metrics.suspiciousRequests.Inc()
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		
		// Add security context
		ctx := r.Context()
		ctx = context.WithValue(ctx, "client_ip", clientIP)
		r = r.WithContext(ctx)
		
		next.ServeHTTP(w, r)
	})
}

func (sm *SecurityMiddleware) applySecurityHeaders(w http.ResponseWriter) {
	// Basic security headers
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-XSS-Protection", "1; mode=block")
	w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'self'")
	
	// REPRAM-specific headers
	w.Header().Set("X-REPRAM-Node", "1.0.0")
}

func (sm *SecurityMiddleware) getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header first (for proxies)
	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		// Take the first IP in the chain
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}
	
	// Check X-Real-IP header
	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}
	
	// Fall back to RemoteAddr
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func (sm *SecurityMiddleware) isSuspiciousRequest(r *http.Request) bool {
	userAgent := r.Header.Get("User-Agent")
	
	// Block common bot/scanner user agents
	suspiciousUAs := []string{
		"sqlmap",
		"nikto",
		"nmap",
		"masscan",
		"gobuster",
		"dirbuster",
		"<script",
		"python-requests", // Block basic scripts (unless legitimate usage)
	}
	
	userAgentLower := strings.ToLower(userAgent)
	for _, suspicious := range suspiciousUAs {
		if strings.Contains(userAgentLower, suspicious) {
			return true
		}
	}
	
	// Check for SQL injection patterns in URL
	url := strings.ToLower(r.URL.String())
	sqlPatterns := []string{
		"union", "select", "insert", "delete", "drop", "exec",
		"script", "alert", "onerror", "onload",
		"../", "..\\", "/etc/passwd", "/proc/",
	}
	
	for _, pattern := range sqlPatterns {
		if strings.Contains(url, pattern) {
			return true
		}
	}
	
	return false
}

func (sm *SecurityMiddleware) Close() {
	if sm.rateLimiter != nil {
		sm.rateLimiter.Close()
	}
}

// Request size limiting middleware
func MaxRequestSizeMiddleware(maxSize int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > maxSize {
				http.Error(w, "Request too large", http.StatusRequestEntityTooLarge)
				return
			}
			
			// Also set a limit on the request body reader
			r.Body = http.MaxBytesReader(w, r.Body, maxSize)
			next.ServeHTTP(w, r)
		})
	}
}

// Timeout middleware to prevent slow loris attacks
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.TimeoutHandler(next, timeout, "Request timeout")
	}
}