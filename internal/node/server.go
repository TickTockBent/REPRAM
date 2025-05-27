package node

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"
)

type Store interface {
	Put(key string, data []byte, ttl time.Duration) error
	Get(key string) ([]byte, bool)
}

type Server struct {
	store Store
}

type PutRequest struct {
	Data []byte `json:"data"`
	TTL  int    `json:"ttl"` // TTL in seconds
}

type ErrorResponse struct {
	Error string `json:"error"`
}

func NewServer(store Store) *Server {
	return &Server{store: store}
}

func (s *Server) Router() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/health", s.healthHandler).Methods("GET")
	r.HandleFunc("/data/{key}", s.putHandler).Methods("PUT")
	r.HandleFunc("/data/{key}", s.getHandler).Methods("GET")
	return r
}

func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK")
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