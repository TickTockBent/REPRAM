package node

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Store interface {
	Put(key string, data []byte, ttl time.Duration) error
	Get(key string) ([]byte, bool)
}

type StatsStore interface {
	Store
	GetStats() (int, int64)
}

type Server struct {
	store Store
	// Metrics
	requestTotal     *prometheus.CounterVec
	requestDuration  *prometheus.HistogramVec
	storageSize      prometheus.Gauge
	storageItems     prometheus.Gauge
	uptime          time.Time
	// Security
	securityMW      *SecurityMiddleware
}

type PutRequest struct {
	Data []byte `json:"data"`
	TTL  int    `json:"ttl"` // TTL in seconds
}

type ErrorResponse struct {
	Error string `json:"error"`
}

func NewServer(store Store) *Server {
	// Initialize Prometheus metrics
	requestTotal := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "repram_requests_total",
			Help: "Total number of HTTP requests",
		},
		[]string{"method", "endpoint", "status"},
	)

	requestDuration := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "repram_request_duration_seconds",
			Help: "HTTP request duration in seconds",
		},
		[]string{"method", "endpoint"},
	)

	storageSize := prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "repram_storage_bytes",
			Help: "Total storage size in bytes",
		},
	)

	storageItems := prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "repram_storage_items",
			Help: "Total number of stored items",
		},
	)

	// Register metrics
	prometheus.MustRegister(requestTotal, requestDuration, storageSize, storageItems)

	// Initialize security middleware
	securityMW := NewSecurityMiddleware(
		100, // 100 requests per second per IP
		200, // burst of 200 requests
		10*1024*1024, // 10MB max request size
	)

	server := &Server{
		store:           store,
		requestTotal:    requestTotal,
		requestDuration: requestDuration,
		storageSize:     storageSize,
		storageItems:    storageItems,
		uptime:          time.Now(),
		securityMW:     securityMW,
	}
	
	// Start metrics updater if store supports stats
	if statsStore, ok := store.(StatsStore); ok {
		go server.updateStorageMetrics(statsStore)
	}
	
	return server
}

func (s *Server) updateStorageMetrics(store StatsStore) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		count, size := store.GetStats()
		s.storageItems.Set(float64(count))
		s.storageSize.Set(float64(size))
	}
}

func (s *Server) Router() *mux.Router {
	r := mux.NewRouter()
	
	// Apply security middleware to all routes
	r.Use(s.securityMW.Middleware)
	r.Use(TimeoutMiddleware(30 * time.Second))
	
	// Health and metrics endpoints (less restrictive)
	health := r.PathPrefix("/health").Subrouter()
	health.HandleFunc("", s.instrumentHandler("health", s.healthHandler)).Methods("GET")
	
	metrics := r.PathPrefix("/metrics").Subrouter()
	metrics.HandleFunc("", promhttp.Handler().ServeHTTP).Methods("GET")
	
	status := r.PathPrefix("/status").Subrouter()
	status.HandleFunc("", s.instrumentHandler("status", s.statusHandler)).Methods("GET")
	
	// Data endpoints with additional size restrictions
	data := r.PathPrefix("/data").Subrouter()
	data.Use(MaxRequestSizeMiddleware(10 * 1024 * 1024)) // 10MB limit
	data.HandleFunc("/{key}", s.instrumentHandler("put", s.putHandler)).Methods("PUT")
	data.HandleFunc("/{key}", s.instrumentHandler("get", s.getHandler)).Methods("GET")
	
	return r
}

func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}

func (s *Server) statusHandler(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	status := map[string]interface{}{
		"status":       "healthy",
		"uptime":       time.Since(s.uptime).String(),
		"version":      "1.0.0",
		"memory": map[string]interface{}{
			"alloc":        m.Alloc,
			"total_alloc":  m.TotalAlloc,
			"sys":          m.Sys,
			"num_gc":       m.NumGC,
		},
		"goroutines":   runtime.NumGoroutine(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(status)
}

func (s *Server) instrumentHandler(endpoint string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Create a response writer that captures the status code
		wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}
		
		// Call the actual handler
		handler(wrapped, r)
		
		// Record metrics
		duration := time.Since(start).Seconds()
		s.requestDuration.WithLabelValues(r.Method, endpoint).Observe(duration)
		s.requestTotal.WithLabelValues(r.Method, endpoint, strconv.Itoa(wrapped.statusCode)).Inc()
	}
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func (s *Server) putHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]
	
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.writeError(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	
	var req PutRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.writeError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	
	if req.TTL <= 0 {
		s.writeError(w, "TTL must be positive", http.StatusBadRequest)
		return
	}
	
	ttl := time.Duration(req.TTL) * time.Second
	if err := s.store.Put(key, req.Data, ttl); err != nil {
		s.writeError(w, "Failed to store data", http.StatusInternalServerError)
		return
	}
	
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, "OK")
}

func (s *Server) getHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]
	
	data, exists := s.store.Get(key)
	if !exists {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

func (s *Server) writeError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{Error: message})
}

// Close shuts down the server gracefully
func (s *Server) Close() error {
	if s.securityMW != nil {
		s.securityMW.Close()
	}
	return nil
}