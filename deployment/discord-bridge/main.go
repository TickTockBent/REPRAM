package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
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
}

func main() {
	log.Println("🚀 Starting Discord-REPRAM Bridge...")

	// Load configuration
	config, err := LoadConfig("config.yaml")
	if err != nil {
		log.Fatalf("❌ Failed to load config: %v", err)
	}

	// Initialize bridge
	bridge, err := NewBridge(config)
	if err != nil {
		log.Fatalf("❌ Failed to initialize bridge: %v", err)
	}

	// Start the bridge
	if err := bridge.Start(); err != nil {
		log.Fatalf("❌ Failed to start bridge: %v", err)
	}

	log.Println("✅ Discord-REPRAM Bridge started successfully!")
	log.Printf("📡 Monitoring channel: %s", config.Discord.ChannelID)
	log.Printf("🌐 Connected to %d REPRAM nodes", len(config.Repram.Nodes))

	// Wait for interrupt signal
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("🛑 Shutting down bridge...")
	bridge.Stop()
	log.Println("👋 Bridge stopped")
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
	}

	// Set up Discord event handlers
	bridge.setupEventHandlers()

	return bridge, nil
}

// Start starts the bridge
func (b *Bridge) Start() error {
	// Open Discord connection
	if err := b.discord.Open(); err != nil {
		return fmt.Errorf("failed to open Discord connection: %w", err)
	}

	// Start background routines
	go b.pollRepramMessages()
	go b.cleanupExpiredMessages()

	return nil
}

// Stop stops the bridge
func (b *Bridge) Stop() {
	if b.discord != nil {
		b.discord.Close()
	}
}

// setupEventHandlers sets up Discord event handlers
func (b *Bridge) setupEventHandlers() {
	// Handle ready event
	b.discord.AddHandler(func(s *discordgo.Session, r *discordgo.Ready) {
		log.Printf("✅ Logged in as: %v#%v", s.State.User.Username, s.State.User.Discriminator)
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

	log.Printf("📨 Processing Discord message: %s", m.Content)

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
		log.Printf("❌ Failed to store message in REPRAM: %v", err)
		return
	}

	log.Printf("✅ Stored message in REPRAM with key: %s", key)

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
	messages, err := b.repramClient.GetRecentMessages()
	if err != nil {
		log.Printf("❌ Failed to get messages from REPRAM: %v", err)
		return
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
			log.Printf("❌ Failed to send message to Discord: %v", err)
			continue
		}

		// Track the message
		expiryTime := msg.Timestamp.Add(time.Duration(msg.TTL) * time.Second)
		b.messageTracker.TrackMessage(msg.Key, discordMsg.ID, expiryTime)

		log.Printf("📤 Synced REPRAM message to Discord: %s", msg.Key)
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

	if b.config.Bridge.EmbedKeys {
		// Embed the key as invisible text (zero-width characters)
		content += fmt.Sprintf("\u200B%s\u200B", msg.Key)
	}

	return content
}

// cleanupExpiredMessages removes expired messages from Discord
func (b *Bridge) cleanupExpiredMessages() {
	ticker := time.NewTicker(time.Duration(b.config.Bridge.CleanupInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			b.messageTracker.CleanupExpired(func(discordMessageID string) {
				err := b.discord.ChannelMessageDelete(b.config.Discord.ChannelID, discordMessageID)
				if err != nil {
					log.Printf("❌ Failed to delete expired message: %v", err)
				} else {
					log.Printf("🗑️ Deleted expired Discord message: %s", discordMessageID)
				}
			})
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