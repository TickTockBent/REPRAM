package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Server hosts the dashboard's two HTTP listeners:
//   - Public:   index.html + /api/snapshot, intended for visitors
//   - Internal: /internal/metrics, bound to localhost by default
//
// The split lets operators expose only the public surface to the Internet
// while keeping operational metrics private to the host. The internal
// address is configurable; binding it to a public address is the
// operator's explicit choice.
type Server struct {
	orch       *Orchestrator
	publicAddr string
	internalAddr string
	assets     fs.FS
	logger     *log.Logger
}

// NewServer wires the orchestrator + embedded assets into an HTTP server
// pair. assets is the embed.FS root containing index.html, app.js, etc.
// The caller passes the sub-FS rooted at the static-asset directory so
// this package does not have to know the embed layout.
func NewServer(orch *Orchestrator, publicAddr, internalAddr string, assets fs.FS, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	return &Server{
		orch:         orch,
		publicAddr:   publicAddr,
		internalAddr: internalAddr,
		assets:       assets,
		logger:       logger,
	}
}

// Run starts both listeners. Blocks until ctx is cancelled, then shuts
// both servers down with a 5s grace period. Returns the first non-graceful
// error encountered.
func (s *Server) Run(ctx context.Context) error {
	publicMux := http.NewServeMux()
	publicMux.HandleFunc("/api/snapshot", s.handleSnapshot)
	publicMux.HandleFunc("/healthz", s.handleHealthz)
	publicMux.Handle("/", http.FileServer(http.FS(s.assets)))

	internalMux := http.NewServeMux()
	internalMux.Handle("/internal/metrics", promhttp.HandlerFor(s.orch.MetricsRegistry(), promhttp.HandlerOpts{}))
	internalMux.HandleFunc("/healthz", s.handleHealthz)

	publicSrv := &http.Server{
		Addr:              s.publicAddr,
		Handler:           publicMux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	internalSrv := &http.Server{
		Addr:              s.internalAddr,
		Handler:           internalMux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 2)
	go func() {
		s.logger.Printf("dashboard: public listener on %s", s.publicAddr)
		if err := publicSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("public listener: %w", err)
		}
	}()
	go func() {
		s.logger.Printf("dashboard: internal listener on %s", s.internalAddr)
		if err := internalSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("internal listener: %w", err)
		}
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = publicSrv.Shutdown(shutdownCtx)
		_ = internalSrv.Shutdown(shutdownCtx)
		return nil
	case err := <-errCh:
		return err
	}
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	snap := s.orch.Snapshot()
	if snap == nil {
		// First poll has not completed and no prior snapshot was on
		// disk. Serve a minimal placeholder rather than 503 — the
		// frontend can render "initializing…" from this.
		snap = &Snapshot{GeneratedAt: time.Now(), Stale: true}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(snap); err != nil {
		s.logger.Printf("dashboard: encode snapshot: %v", err)
	}
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}
