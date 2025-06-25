package main

import (
	"os"
	"gopkg.in/yaml.v2"
)

// Config represents the bridge configuration
type Config struct {
	Discord     DiscordConfig     `yaml:"discord"`
	Repram      RepramConfig      `yaml:"repram"`
	Bridge      BridgeConfig      `yaml:"bridge"`
	TTLCommands TTLCommandsConfig `yaml:"ttl_commands"`
	Logging     LoggingConfig     `yaml:"logging"`
	Performance PerformanceConfig `yaml:"performance"`
}

// DiscordConfig holds Discord-specific configuration
type DiscordConfig struct {
	Token     string `yaml:"token"`
	ChannelID string `yaml:"channel_id"`
	GuildID   string `yaml:"guild_id"`
}

// RepramConfig holds REPRAM-specific configuration
type RepramConfig struct {
	Nodes      []string `yaml:"nodes"`
	DefaultTTL int      `yaml:"default_ttl"`
	MinTTL     int      `yaml:"min_ttl"`
	MaxTTL     int      `yaml:"max_ttl"`
}

// BridgeConfig holds bridge behavior configuration
type BridgeConfig struct {
	RepramPrefix            string `yaml:"repram_prefix"`
	DiscordPrefix           string `yaml:"discord_prefix"`
	ShowTTL                 bool   `yaml:"show_ttl"`
	TTLFormat               string `yaml:"ttl_format"`
	EmbedKeys               bool   `yaml:"embed_keys"`
	ShowKeys                bool   `yaml:"show_keys"`
	PollInterval            int    `yaml:"poll_interval"`
	CleanupInterval         int    `yaml:"cleanup_interval"`
	MaxDeletionsPerCleanup  int    `yaml:"max_deletions_per_cleanup"`
	DeletionRateLimit       int    `yaml:"deletion_rate_limit"`
	DeletionQueueSize       int    `yaml:"deletion_queue_size"`
	RateLimitRetryDelay     int    `yaml:"rate_limit_retry_delay"`
}

// TTLCommandsConfig holds TTL command configuration
type TTLCommandsConfig struct {
	Enabled    bool   `yaml:"enabled"`
	Prefix     string `yaml:"prefix"`
	MinTTL     int    `yaml:"min_ttl"`
	MaxTTL     int    `yaml:"max_ttl"`
	DefaultTTL int    `yaml:"default_ttl"`
}

// LoggingConfig holds logging configuration
type LoggingConfig struct {
	Level string `yaml:"level"`
	File  string `yaml:"file"`
}

// PerformanceConfig holds performance-related configuration
type PerformanceConfig struct {
	MaxConcurrentRequests int `yaml:"max_concurrent_requests"`
	RequestTimeout        int `yaml:"request_timeout"`
	RetryAttempts         int `yaml:"retry_attempts"`
	RetryDelay            int `yaml:"retry_delay"`
}

// LoadConfig loads configuration from a YAML file
func LoadConfig(filename string) (*Config, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	// Set defaults if not specified
	if config.Repram.DefaultTTL == 0 {
		config.Repram.DefaultTTL = 3600
	}
	if config.Repram.MinTTL == 0 {
		config.Repram.MinTTL = 300
	}
	if config.Repram.MaxTTL == 0 {
		config.Repram.MaxTTL = 604800
	}
	if config.Bridge.PollInterval == 0 {
		config.Bridge.PollInterval = 10
	}
	if config.Bridge.CleanupInterval == 0 {
		config.Bridge.CleanupInterval = 60
	}
	if config.Bridge.MaxDeletionsPerCleanup == 0 {
		config.Bridge.MaxDeletionsPerCleanup = 3
	}
	if config.Bridge.DeletionRateLimit == 0 {
		config.Bridge.DeletionRateLimit = 333
	}
	if config.Bridge.DeletionQueueSize == 0 {
		config.Bridge.DeletionQueueSize = 1000
	}
	if config.Bridge.RateLimitRetryDelay == 0 {
		config.Bridge.RateLimitRetryDelay = 2
	}
	if config.TTLCommands.Prefix == "" {
		config.TTLCommands.Prefix = "/ttl"
	}

	// Override Discord config with environment variables if present
	if token := os.Getenv("DISCORD_TOKEN"); token != "" {
		config.Discord.Token = token
	}
	if channelID := os.Getenv("DISCORD_CHANNEL_ID"); channelID != "" {
		config.Discord.ChannelID = channelID
	}
	if guildID := os.Getenv("DISCORD_GUILD_ID"); guildID != "" {
		config.Discord.GuildID = guildID
	}

	return &config, nil
}