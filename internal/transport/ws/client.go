package ws

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// ConnectToSubstrate opens an outbound WebSocket to address:port on the
// /v1/ws endpoint and returns a wrapped Connection. The connection will
// HMAC-sign outgoing frames when clusterSecret is non-empty. A zero timeout
// applies a 10s default.
func ConnectToSubstrate(ctx context.Context, address string, port int, clusterSecret string, timeout time.Duration) (*Connection, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	url := fmt.Sprintf("ws://%s:%d/v1/ws", address, port)

	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dialer := &websocket.Dialer{HandshakeTimeout: timeout}
	ws, resp, err := dialer.DialContext(dialCtx, url, http.Header{})
	if err != nil {
		if resp != nil {
			_ = resp.Body.Close()
		}
		if errors.Is(dialCtx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("WebSocket connection to %s timed out: %w", url, err)
		}
		return nil, fmt.Errorf("WebSocket connection to %s failed: %w", url, err)
	}
	if resp != nil {
		_ = resp.Body.Close()
	}
	return NewConnection(ws, clusterSecret), nil
}
