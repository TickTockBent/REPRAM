package main

import (
	"sync"
	"time"
)

// TrackedMessage represents a message being tracked for TTL-based cleanup
type TrackedMessage struct {
	RepramKey        string    `json:"repram_key"`
	DiscordMessageID string    `json:"discord_message_id"`
	ExpiryTime       time.Time `json:"expiry_time"`
	CreatedAt        time.Time `json:"created_at"`
}

// MessageTracker manages TTL-based message tracking and cleanup
type MessageTracker struct {
	messages map[string]*TrackedMessage
	mutex    sync.RWMutex
}

// NewMessageTracker creates a new message tracker instance
func NewMessageTracker() *MessageTracker {
	return &MessageTracker{
		messages: make(map[string]*TrackedMessage),
	}
}

// TrackMessage adds a message to the tracking system
func (mt *MessageTracker) TrackMessage(repramKey, discordMessageID string, expiryTime time.Time) {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()

	mt.messages[repramKey] = &TrackedMessage{
		RepramKey:        repramKey,
		DiscordMessageID: discordMessageID,
		ExpiryTime:       expiryTime,
		CreatedAt:        time.Now(),
	}
}

// IsTracked checks if a message is already being tracked
func (mt *MessageTracker) IsTracked(repramKey string) bool {
	mt.mutex.RLock()
	defer mt.mutex.RUnlock()

	_, exists := mt.messages[repramKey]
	return exists
}

// GetTrackedMessage retrieves a tracked message by REPRAM key
func (mt *MessageTracker) GetTrackedMessage(repramKey string) (*TrackedMessage, bool) {
	mt.mutex.RLock()
	defer mt.mutex.RUnlock()

	msg, exists := mt.messages[repramKey]
	return msg, exists
}

// UntrackMessage removes a message from tracking
func (mt *MessageTracker) UntrackMessage(repramKey string) {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()

	delete(mt.messages, repramKey)
}

// CleanupExpired removes expired messages with Discord API rate limiting
// Discord allows ~5 message deletions per second, so we spread deletions over time
func (mt *MessageTracker) CleanupExpired(cleanupFunc func(discordMessageID string), maxDeletions int) []string {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()

	now := time.Now()
	var expiredKeys []string

	// Find expired messages
	for key, msg := range mt.messages {
		if now.After(msg.ExpiryTime) {
			expiredKeys = append(expiredKeys, key)
		}
	}

	// Use configurable max deletions per cleanup cycle
	deletedCount := 0

	for _, key := range expiredKeys {
		msg := mt.messages[key]
		
		// Try to delete the Discord message
		if cleanupFunc != nil && deletedCount < maxDeletions {
			cleanupFunc(msg.DiscordMessageID)
			deletedCount++
		}
		
		// Remove from tracking regardless (avoid memory leaks)
		delete(mt.messages, key)
	}

	if len(expiredKeys) > 0 {
		if deletedCount < len(expiredKeys) {
			println("🧹 Cleaned up", len(expiredKeys), "expired messages (", deletedCount, "deleted,", len(expiredKeys)-deletedCount, "rate limited)")
		} else {
			println("🧹 Cleaned up", len(expiredKeys), "expired messages")
		}
	}

	// Return expired keys for potential retry logic
	return expiredKeys
}

// GetExpiringMessages returns messages that will expire within the given duration
func (mt *MessageTracker) GetExpiringMessages(within time.Duration) []*TrackedMessage {
	mt.mutex.RLock()
	defer mt.mutex.RUnlock()

	var expiring []*TrackedMessage
	threshold := time.Now().Add(within)

	for _, msg := range mt.messages {
		if msg.ExpiryTime.Before(threshold) {
			expiring = append(expiring, msg)
		}
	}

	return expiring
}

// GetAllTrackedMessages returns all currently tracked messages
func (mt *MessageTracker) GetAllTrackedMessages() []*TrackedMessage {
	mt.mutex.RLock()
	defer mt.mutex.RUnlock()

	var all []*TrackedMessage
	for _, msg := range mt.messages {
		all = append(all, msg)
	}

	return all
}

// UpdateExpiryTime updates the expiry time for a tracked message
func (mt *MessageTracker) UpdateExpiryTime(repramKey string, newExpiryTime time.Time) bool {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()

	if msg, exists := mt.messages[repramKey]; exists {
		msg.ExpiryTime = newExpiryTime
		return true
	}

	return false
}

// GetStats returns statistics about tracked messages
func (mt *MessageTracker) GetStats() map[string]interface{} {
	mt.mutex.RLock()
	defer mt.mutex.RUnlock()

	now := time.Now()
	var expired, expiring, active int

	for _, msg := range mt.messages {
		if now.After(msg.ExpiryTime) {
			expired++
		} else if msg.ExpiryTime.Before(now.Add(5 * time.Minute)) {
			expiring++
		} else {
			active++
		}
	}

	return map[string]interface{}{
		"total":    len(mt.messages),
		"active":   active,
		"expiring": expiring,
		"expired":  expired,
	}
}

// CleanupOld removes very old messages that might have been missed
func (mt *MessageTracker) CleanupOld(maxAge time.Duration, cleanupFunc func(discordMessageID string)) {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()

	cutoff := time.Now().Add(-maxAge)
	var oldKeys []string

	// Find old messages
	for key, msg := range mt.messages {
		if msg.CreatedAt.Before(cutoff) {
			oldKeys = append(oldKeys, key)
			
			// Call cleanup function for Discord message deletion
			if cleanupFunc != nil {
				cleanupFunc(msg.DiscordMessageID)
			}
		}
	}

	// Remove old messages from tracking
	for _, key := range oldKeys {
		delete(mt.messages, key)
	}

	if len(oldKeys) > 0 {
		println("🧹 Cleaned up", len(oldKeys), "old messages")
	}
}