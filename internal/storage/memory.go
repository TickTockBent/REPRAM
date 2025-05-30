package storage

import (
	"sync"
	"time"
)

type Entry struct {
	Data      []byte    `json:"data"`
	ExpiresAt time.Time `json:"expires_at"`
}

type MemoryStore struct {
	data    map[string]*Entry
	mutex   sync.RWMutex
	cleanup chan bool
}

func NewMemoryStore() *MemoryStore {
	store := &MemoryStore{
		data:    make(map[string]*Entry),
		cleanup: make(chan bool),
	}
	
	go store.startCleanupWorker()
	return store
}

func (m *MemoryStore) Put(key string, data []byte, ttl time.Duration) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	
	m.data[key] = &Entry{
		Data:      data,
		ExpiresAt: time.Now().Add(ttl),
	}
	return nil
}

func (m *MemoryStore) Get(key string) ([]byte, bool) {
	m.mutex.RLock()
	defer m.mutex.RUnlock()
	
	entry, exists := m.data[key]
	if !exists {
		return nil, false
	}
	
	if time.Now().After(entry.ExpiresAt) {
		delete(m.data, key)
		return nil, false
	}
	
	return entry.Data, true
}

func (m *MemoryStore) startCleanupWorker() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			m.cleanupExpired()
		case <-m.cleanup:
			return
		}
	}
}

func (m *MemoryStore) cleanupExpired() {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	
	now := time.Now()
	for key, entry := range m.data {
		if now.After(entry.ExpiresAt) {
			delete(m.data, key)
		}
	}
}

func (m *MemoryStore) Close() {
	close(m.cleanup)
}

// GetStats returns storage statistics
func (m *MemoryStore) GetStats() (int, int64) {
	m.mutex.RLock()
	defer m.mutex.RUnlock()
	
	count := len(m.data)
	var totalSize int64
	
	for _, entry := range m.data {
		totalSize += int64(len(entry.Data))
	}
	
	return count, totalSize
}

// Range iterates over all non-expired keys
// The callback function receives the key and remaining TTL in seconds
// If the callback returns false, iteration stops
func (m *MemoryStore) Range(fn func(key string, ttl int) bool) {
	m.mutex.RLock()
	defer m.mutex.RUnlock()
	
	now := time.Now()
	for key, entry := range m.data {
		if now.After(entry.ExpiresAt) {
			continue // Skip expired entries
		}
		
		remainingTTL := int(entry.ExpiresAt.Sub(now).Seconds())
		if !fn(key, remainingTTL) {
			break
		}
	}
}

// Scan returns all non-expired keys
func (m *MemoryStore) Scan() []string {
	m.mutex.RLock()
	defer m.mutex.RUnlock()
	
	var keys []string
	now := time.Now()
	for key, entry := range m.data {
		if !now.After(entry.ExpiresAt) { // Not expired
			keys = append(keys, key)
		}
	}
	
	return keys
}