package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/bwmarrin/discordgo"
)

// Bridge represents the Discord-REPRAM bridge
type Bridge struct {
	config         *Config
	discord        *discordgo.Session
	repramClient   *RepramClient
	messageTracker *MessageTracker
	deletionQueue  chan string // Queue for rate-limited message deletion
	
	// Health tracking
	messagesFromDiscord uint64
	messagesToDiscord   uint64
	lastActivity        time.Time
	startTime           time.Time
	isConnected         bool
	
	// Crash recovery
	lastPollAttempt     time.Time
	pollCrashCount      uint64
	cleanupCrashCount   uint64
}

func main() {
	log.Println(">>> INITIALIZING DISCORD-REPRAM BRIDGE PROTOCOL...")

	// Load configuration
	config, err := LoadConfig("config.yaml")
	if err != nil {
		log.Fatalf("❌ CRITICAL: CONFIG PROTOCOL FAILURE: %v", err)
	}

	// Initialize bridge
	bridge, err := NewBridge(config)
	if err != nil {
		log.Fatalf("❌ FATAL: BRIDGE INITIALIZATION FAILED: %v", err)
	}

	// Start the bridge
	if err := bridge.Start(); err != nil {
		log.Fatalf("❌ ABORT: BRIDGE STARTUP SEQUENCE FAILED: %v", err)
	}

	log.Println("✅ BRIDGE ONLINE // EPHEMERAL SYNC PROTOCOL ACTIVE")
	log.Printf("📡 MONITORING CHANNEL: %s", config.Discord.ChannelID)
	log.Printf("🌐 LINKED TO %d REPRAM NODES // DISTRIBUTED NETWORK", len(config.Repram.Nodes))

	// Wait for interrupt signal
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("🛑 TERMINATION SIGNAL RECEIVED // INITIATING SHUTDOWN...")
	bridge.Stop()
	log.Println("👋 BRIDGE DISCONNECTED // END OF LINE")
}

// NewBridge creates a new Discord-REPRAM bridge instance
func NewBridge(config *Config) (*Bridge, error) {
	// Initialize Discord session
	discord, err := discordgo.New("Bot " + config.Discord.Token)
	if err != nil {
		return nil, fmt.Errorf("failed to create Discord session: %w", err)
	}

	// Initialize REPRAM client
	repramClient := NewRepramClient(config.Repram.Nodes)

	// Initialize message tracker
	messageTracker := NewMessageTracker()

	bridge := &Bridge{
		config:         config,
		discord:        discord,
		repramClient:   repramClient,
		messageTracker: messageTracker,
		deletionQueue:  make(chan string, config.Bridge.DeletionQueueSize),
	}

	// Set up Discord event handlers
	bridge.setupEventHandlers()

	return bridge, nil
}

// Start starts the bridge
func (b *Bridge) Start() error {
	// Set start time
	b.startTime = time.Now()
	
	// Open Discord connection
	if err := b.discord.Open(); err != nil {
		return fmt.Errorf("failed to open Discord connection: %w", err)
	}
	
	b.isConnected = true

	// Start health endpoint
	go b.startHealthServer()

	// Start background routines with crash recovery
	go b.pollRepramMessagesWithRecovery()
	go b.cleanupExpiredMessagesWithRecovery()
	go b.processDeleteQueue() // Rate-limited deletion processor
	go b.monitorGoroutineHealth() // Health monitor

	return nil
}

// startHealthServer starts the HTTP health endpoint
func (b *Bridge) startHealthServer() {
	http.HandleFunc("/health", b.healthHandler)
	
	log.Println("🌐 HEALTH ENDPOINT ACTIVE // PORT 8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Printf("❌ HEALTH SERVER ERROR: %v", err)
	}
}

// healthHandler returns bridge health status
func (b *Bridge) healthHandler(w http.ResponseWriter, r *http.Request) {
	uptime := time.Since(b.startTime)
	
	health := map[string]interface{}{
		"status": "healthy",
		"connected": b.isConnected,
		"uptime_seconds": int(uptime.Seconds()),
		"statistics": map[string]interface{}{
			"messages_from_discord": atomic.LoadUint64(&b.messagesFromDiscord),
			"messages_to_discord": atomic.LoadUint64(&b.messagesToDiscord),
			"tracked_messages": b.messageTracker.Count(),
			"last_activity": b.lastActivity.Format(time.RFC3339),
			"last_poll_attempt": b.lastPollAttempt.Format(time.RFC3339),
			"poll_crash_count": atomic.LoadUint64(&b.pollCrashCount),
			"cleanup_crash_count": atomic.LoadUint64(&b.cleanupCrashCount),
		},
		"discord": map[string]interface{}{
			"channel_id": b.config.Discord.ChannelID,
			"guild_id": b.config.Discord.GuildID,
		},
		"repram": map[string]interface{}{
			"nodes": b.config.Repram.Nodes,
		},
		"version": "1.0.0",
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(health)
}

// Stop stops the bridge
func (b *Bridge) Stop() {
	b.isConnected = false
	if b.discord != nil {
		b.discord.Close()
	}
}

// setupEventHandlers sets up Discord event handlers
func (b *Bridge) setupEventHandlers() {
	// Handle ready event
	b.discord.AddHandler(func(s *discordgo.Session, r *discordgo.Ready) {
		log.Printf("🤖 NEURAL LINK ESTABLISHED: %v#%v // AWAITING TRANSMISSIONS", s.State.User.Username, s.State.User.Discriminator)
	})

	// Handle message create event
	b.discord.AddHandler(b.onMessageCreate)
}

// onMessageCreate handles new Discord messages
func (b *Bridge) onMessageCreate(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Ignore messages from the bot itself
	if m.Author.ID == s.State.User.ID {
		return
	}

	// Only process messages from the configured channel
	if m.ChannelID != b.config.Discord.ChannelID {
		return
	}

	// Ignore messages that came from REPRAM (have our prefix)
	if len(m.Content) > 0 && m.Content[0:1] == b.config.Bridge.RepramPrefix {
		return
	}

	log.Printf("📡 INCOMING TRANSMISSION FROM %s: %s", m.Author.Username, m.Content)

	// Parse TTL command if present
	content, ttl := b.parseTTLCommand(m.Content)
	if ttl == 0 {
		ttl = b.config.Repram.DefaultTTL
	}

	// Create REPRAM message
	repramMessage := &RepramMessage{
		Content:   content,
		Author:    m.Author.Username,
		Timestamp: time.Now(),
		TTL:       ttl,
		Source:    "discord",
	}

	// Store in REPRAM
	key, err := b.repramClient.StoreMessage(repramMessage)
	if err != nil {
		log.Printf("❌ TRANSMISSION FAILED // REPRAM STORAGE ERROR: %v", err)
		return
	}

	// Update statistics
	atomic.AddUint64(&b.messagesFromDiscord, 1)
	b.lastActivity = time.Now()

	log.Printf("✅ MESSAGE UPLOADED TO REPRAM NETWORK // KEY: %s", key)

	// Track the message for cleanup
	b.messageTracker.TrackMessage(key, m.ID, time.Now().Add(time.Duration(ttl)*time.Second))

	// React to the message to show it was processed
	s.MessageReactionAdd(m.ChannelID, m.ID, "✅")
}

// parseTTLCommand parses TTL commands like "/ttl60 Hello world"
func (b *Bridge) parseTTLCommand(content string) (string, int) {
	if !b.config.TTLCommands.Enabled {
		return content, 0
	}

	// Check if message starts with TTL prefix
	if len(content) < len(b.config.TTLCommands.Prefix) {
		return content, 0
	}

	if content[:len(b.config.TTLCommands.Prefix)] != b.config.TTLCommands.Prefix {
		return content, 0
	}

	// Parse TTL value
	var ttl int
	var message string
	n, err := fmt.Sscanf(content, b.config.TTLCommands.Prefix+"%d %s", &ttl, &message)
	if err != nil || n < 2 {
		return content, 0
	}

	// Validate TTL range
	if ttl < b.config.TTLCommands.MinTTL {
		ttl = b.config.TTLCommands.MinTTL
	}
	if ttl > b.config.TTLCommands.MaxTTL {
		ttl = b.config.TTLCommands.MaxTTL
	}

	// Extract the rest of the message
	prefixLen := len(b.config.TTLCommands.Prefix) + len(fmt.Sprintf("%d ", ttl))
	if len(content) > prefixLen {
		message = content[prefixLen:]
	}

	return message, ttl
}

// pollRepramMessages polls REPRAM for new messages and posts them to Discord
func (b *Bridge) pollRepramMessages() {
	// Do an initial sync immediately
	log.Println("🔄 INITIAL SYNC // SCANNING REPRAM NETWORK...")
	b.syncRepramToDiscord()
	
	ticker := time.NewTicker(time.Duration(b.config.Bridge.PollInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			b.syncRepramToDiscord()
		}
	}
}

// syncRepramToDiscord syncs messages from REPRAM to Discord
func (b *Bridge) syncRepramToDiscord() {
	// Update heartbeat timestamp
	b.lastPollAttempt = time.Now()
	
	messages, err := b.repramClient.GetRecentMessages()
	if err != nil {
		log.Printf("❌ REPRAM NETWORK SCAN FAILED: %v", err)
		return
	}
	
	if len(messages) > 0 {
		log.Printf("📊 FOUND %d MESSAGES IN REPRAM NETWORK", len(messages))
	} else {
		// Log every 10th scan attempt when no messages found (reduce noise)
		if time.Now().Unix()%10 == 0 {
			log.Println("🔍 NETWORK SCAN COMPLETE // NO NEW MESSAGES")
		}
	}

	for _, msg := range messages {
		// Skip if we've already posted this message
		if b.messageTracker.IsTracked(msg.Key) {
			continue
		}

		// Skip messages that originated from Discord
		if msg.Source == "discord" {
			continue
		}

		// Format message for Discord
		discordContent := b.formatRepramMessage(msg)

		// Post to Discord
		discordMsg, err := b.discord.ChannelMessageSend(b.config.Discord.ChannelID, discordContent)
		if err != nil {
			log.Printf("❌ DISCORD TRANSMISSION FAILED: %v", err)
			continue
		}

		// Update statistics
		atomic.AddUint64(&b.messagesToDiscord, 1)
		b.lastActivity = time.Now()

		// Track the message
		expiryTime := msg.Timestamp.Add(time.Duration(msg.TTL) * time.Second)
		b.messageTracker.TrackMessage(msg.Key, discordMsg.ID, expiryTime)

		log.Printf("📤 FADE MESSAGE RELAYED TO DISCORD // KEY: %s", msg.Key)
	}
}

// formatRepramMessage formats a REPRAM message for Discord
func (b *Bridge) formatRepramMessage(msg *RepramMessage) string {
	content := fmt.Sprintf("%s **%s**: %s", b.config.Bridge.RepramPrefix, msg.Author, msg.Content)

	if b.config.Bridge.ShowTTL {
		remaining := time.Until(msg.Timestamp.Add(time.Duration(msg.TTL) * time.Second))
		if remaining > 0 {
			ttlText := fmt.Sprintf(b.config.Bridge.TTLFormat, formatDuration(remaining))
			content += "\n" + ttlText
		}
	}

	if b.config.Bridge.ShowKeys {
		// Show the message key visibly for direct lookup
		content += fmt.Sprintf("\n🔑 `%s`", msg.Key)
	}

	if b.config.Bridge.EmbedKeys {
		// Embed the key as invisible text (zero-width characters)
		content += fmt.Sprintf("\u200B%s\u200B", msg.Key)
	}

	return content
}

// cleanupExpiredMessages removes expired messages from Discord with rate limiting
func (b *Bridge) cleanupExpiredMessages() {
	ticker := time.NewTicker(time.Duration(b.config.Bridge.CleanupInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// Use rate-limited cleanup - queue messages for deletion
			expiredCount := len(b.messageTracker.CleanupExpired(func(discordMessageID string) {
				select {
				case b.deletionQueue <- discordMessageID:
					// Successfully queued for deletion
				default:
					// Queue is full, log and skip (eventual deletion)
					log.Printf("⚠️ Deletion queue full, skipping message: %s", discordMessageID)
				}
			}, b.config.Bridge.MaxDeletionsPerCleanup))
			
			if expiredCount > 0 {
				queueLen := len(b.deletionQueue)
				log.Printf("⚡ TTL SWEEP COMPLETE: %d EXPIRED // %d QUEUED FOR PURGE", expiredCount, queueLen)
			}
		}
	}
}

// processDeleteQueue handles rate-limited Discord message deletion
func (b *Bridge) processDeleteQueue() {
	// Use configurable rate limit
	ticker := time.NewTicker(time.Duration(b.config.Bridge.DeletionRateLimit) * time.Millisecond)
	defer ticker.Stop()

	log.Printf("🗑️ TTL ENFORCEMENT PROTOCOL ACTIVE // DELETION RATE: %dms", b.config.Bridge.DeletionRateLimit)

	for {
		select {
		case <-ticker.C:
			// Try to process one message from the queue
			select {
			case messageID := <-b.deletionQueue:
				err := b.discord.ChannelMessageDelete(b.config.Discord.ChannelID, messageID)
				if err != nil {
					// Check if it's a rate limit error
					if strings.Contains(err.Error(), "rate limit") || strings.Contains(err.Error(), "429") {
						// Put the message back in the queue for retry
						select {
						case b.deletionQueue <- messageID:
							log.Printf("⏳ DISCORD API THROTTLED // REQUEUING: %s", messageID)
						default:
							log.Printf("❌ DELETION QUEUE OVERLOAD // DROPPING: %s", messageID)
						}
						
						// Wait longer before next attempt using configurable delay
						time.Sleep(time.Duration(b.config.Bridge.RateLimitRetryDelay) * time.Second)
					} else if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "404") {
						// Message already deleted or doesn't exist - this is OK
						log.Printf("ℹ️ MESSAGE ALREADY PURGED FROM CHANNEL: %s", messageID)
					} else {
						// Other error - log but don't retry
						log.Printf("❌ DELETION PROTOCOL ERROR: %v", err)
					}
				} else {
					log.Printf("🗑️ TTL EXPIRED // MESSAGE PURGED: %s", messageID)
				}
			default:
				// No messages in queue, continue
			}
		}
	}
}

// formatDuration formats a duration for display
func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

// pollRepramMessagesWithRecovery wraps polling with crash recovery
func (b *Bridge) pollRepramMessagesWithRecovery() {
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					atomic.AddUint64(&b.pollCrashCount, 1)
					log.Printf("❌ CRITICAL: POLLING GOROUTINE CRASHED // PANIC: %v", r)
					log.Println("🔄 RESTARTING POLLING IN 5 SECONDS...")
					time.Sleep(5 * time.Second)
				}
			}()
			
			log.Println("🔄 POLLING GOROUTINE STARTED // MONITORING REPRAM NETWORK")
			b.pollRepramMessages()
		}()
	}
}

// cleanupExpiredMessagesWithRecovery wraps cleanup with crash recovery
func (b *Bridge) cleanupExpiredMessagesWithRecovery() {
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					atomic.AddUint64(&b.cleanupCrashCount, 1)
					log.Printf("❌ CRITICAL: CLEANUP GOROUTINE CRASHED // PANIC: %v", r)
					log.Println("🔄 RESTARTING CLEANUP IN 10 SECONDS...")
					time.Sleep(10 * time.Second)
				}
			}()
			
			log.Println("🗑️ CLEANUP GOROUTINE STARTED // TTL ENFORCEMENT ACTIVE")
			b.cleanupExpiredMessages()
		}()
	}
}

// monitorGoroutineHealth monitors goroutine health and logs warnings
func (b *Bridge) monitorGoroutineHealth() {
	ticker := time.NewTicker(60 * time.Second) // Check every minute
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Check if polling has stalled
			timeSinceLastPoll := time.Since(b.lastPollAttempt)
			if timeSinceLastPoll > 30*time.Second {
				log.Printf("⚠️ WARNING: NO POLLING ACTIVITY FOR %v // POTENTIAL GOROUTINE FAILURE", timeSinceLastPoll)
			}
			
			// Log crash counts if any
			pollCrashes := atomic.LoadUint64(&b.pollCrashCount)
			cleanupCrashes := atomic.LoadUint64(&b.cleanupCrashCount)
			
			if pollCrashes > 0 || cleanupCrashes > 0 {
				log.Printf("📊 CRASH STATISTICS // POLL: %d, CLEANUP: %d", pollCrashes, cleanupCrashes)
			}
		}
	}
}