export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activities: {
        Row: {
          completed_at: string | null
          contact_id: string | null
          created_at: string
          deal_id: string | null
          due_at: string | null
          id: string
          metadata: Json
          owner_id: string | null
          tenant_id: string
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          deal_id?: string | null
          due_at?: string | null
          id?: string
          metadata?: Json
          owner_id?: string | null
          tenant_id: string
          title: string
          type?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          deal_id?: string | null
          due_at?: string | null
          id?: string
          metadata?: Json
          owner_id?: string | null
          tenant_id?: string
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "activities_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_platform_agent_links: {
        Row: {
          created_at: string
          id: string
          last_known_active: boolean | null
          last_sync_at: string
          name: string | null
          platform_agent_id: string
          platform_workspace_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_known_active?: boolean | null
          last_sync_at?: string
          name?: string | null
          platform_agent_id: string
          platform_workspace_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_known_active?: boolean | null
          last_sync_at?: string
          name?: string | null
          platform_agent_id?: string
          platform_workspace_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_platform_agent_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_platform_audit_log: {
        Row: {
          action: string
          correlation_id: string | null
          created_at: string
          error_code: string | null
          id: string
          resource_id: string | null
          resource_type: string
          status: string
          tenant_id: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          action: string
          correlation_id?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          resource_id?: string | null
          resource_type: string
          status: string
          tenant_id: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          action?: string
          correlation_id?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          resource_id?: string | null
          resource_type?: string
          status?: string
          tenant_id?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_platform_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_platform_channel_links: {
        Row: {
          channel_type: string
          connected: boolean | null
          created_at: string
          id: string
          last_sync_at: string
          name: string | null
          platform_agent_id: string | null
          platform_channel_id: string
          platform_workspace_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          channel_type: string
          connected?: boolean | null
          created_at?: string
          id?: string
          last_sync_at?: string
          name?: string | null
          platform_agent_id?: string | null
          platform_channel_id: string
          platform_workspace_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          channel_type?: string
          connected?: boolean | null
          created_at?: string
          id?: string
          last_sync_at?: string
          name?: string | null
          platform_agent_id?: string | null
          platform_channel_id?: string
          platform_workspace_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_platform_channel_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_platform_training_events: {
        Row: {
          dedupe_key: string
          id: string
          message: string | null
          payload: Json
          platform_agent_id: string | null
          platform_training_id: string | null
          received_at: string
          status: string
          tenant_id: string
        }
        Insert: {
          dedupe_key: string
          id?: string
          message?: string | null
          payload?: Json
          platform_agent_id?: string | null
          platform_training_id?: string | null
          received_at?: string
          status: string
          tenant_id: string
        }
        Update: {
          dedupe_key?: string
          id?: string
          message?: string | null
          payload?: Json
          platform_agent_id?: string | null
          platform_training_id?: string | null
          received_at?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_platform_training_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_conversation_summaries: {
        Row: {
          commitments: string[]
          contact_id: string
          conversation_id: string
          created_at: string
          deal_id: string | null
          id: string
          key_facts: string[]
          messages_covered: number
          objections: string[]
          open_questions: string[]
          period_end: string
          period_start: string
          sentiment: string | null
          summary: string
          tenant_id: string
          topics_discussed: string[]
        }
        Insert: {
          commitments?: string[]
          contact_id: string
          conversation_id: string
          created_at?: string
          deal_id?: string | null
          id?: string
          key_facts?: string[]
          messages_covered: number
          objections?: string[]
          open_questions?: string[]
          period_end: string
          period_start: string
          sentiment?: string | null
          summary: string
          tenant_id: string
          topics_discussed?: string[]
        }
        Update: {
          commitments?: string[]
          contact_id?: string
          conversation_id?: string
          created_at?: string
          deal_id?: string | null
          id?: string
          key_facts?: string[]
          messages_covered?: number
          objections?: string[]
          open_questions?: string[]
          period_end?: string
          period_start?: string
          sentiment?: string | null
          summary?: string
          tenant_id?: string
          topics_discussed?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "ai_conversation_summaries_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_conversation_summaries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_conversation_summaries_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "ai_conversation_summaries_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_conversation_summaries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_failure_logs: {
        Row: {
          context: Json
          created_at: string
          error_code: string
          error_message: string
          id: string
          model: string | null
          provider: string | null
          route: string
          status_code: number | null
          tenant_id: string
          trace_id: string | null
        }
        Insert: {
          context?: Json
          created_at?: string
          error_code: string
          error_message: string
          id?: string
          model?: string | null
          provider?: string | null
          route: string
          status_code?: number | null
          tenant_id: string
          trace_id?: string | null
        }
        Update: {
          context?: Json
          created_at?: string
          error_code?: string
          error_message?: string
          id?: string
          model?: string | null
          provider?: string | null
          route?: string
          status_code?: number | null
          tenant_id?: string
          trace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_failure_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_feature_catalog: {
        Row: {
          created_at: string
          default_enabled: boolean
          description: string | null
          feature_key: string
          label: string
          toggle_authority: string
        }
        Insert: {
          created_at?: string
          default_enabled?: boolean
          description?: string | null
          feature_key: string
          label: string
          toggle_authority?: string
        }
        Update: {
          created_at?: string
          default_enabled?: boolean
          description?: string | null
          feature_key?: string
          label?: string
          toggle_authority?: string
        }
        Relationships: []
      }
      ai_insights: {
        Row: {
          created_at: string
          id: string
          insights: Json
          model: string
          period_from: string
          period_to: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          insights: Json
          model?: string
          period_from: string
          period_to: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          insights?: Json
          model?: string
          period_from?: string
          period_to?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_insights_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_insights_write_failures: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          request_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          request_id?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          request_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_insights_write_failures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_lead_verdicts: {
        Row: {
          contact_id: string
          created_at: string
          id: string
          model: string
          rationale: string | null
          source: string
          tenant_id: string
          verdict: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: string
          model: string
          rationale?: string | null
          source?: string
          tenant_id: string
          verdict: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: string
          model?: string
          rationale?: string | null
          source?: string
          tenant_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_lead_verdicts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: true
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_lead_verdicts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_pending_stage_advances: {
        Row: {
          confidence: number
          conversation_id: string | null
          created_at: string
          criteria_evaluation: Json
          current_stage_id: string
          deal_id: string
          evidence: Json
          expires_at: string
          id: string
          reason: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          suggested_stage_id: string
          tenant_id: string
          transition_command_id: string | null
          user_edits: Json | null
        }
        Insert: {
          confidence: number
          conversation_id?: string | null
          created_at?: string
          criteria_evaluation?: Json
          current_stage_id: string
          deal_id: string
          evidence?: Json
          expires_at?: string
          id?: string
          reason: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          suggested_stage_id: string
          tenant_id: string
          transition_command_id?: string | null
          user_edits?: Json | null
        }
        Update: {
          confidence?: number
          conversation_id?: string | null
          created_at?: string
          criteria_evaluation?: Json
          current_stage_id?: string
          deal_id?: string
          evidence?: Json
          expires_at?: string
          id?: string
          reason?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          suggested_stage_id?: string
          tenant_id?: string
          transition_command_id?: string | null
          user_edits?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_pending_stage_advances_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_current_stage_id_fkey"
            columns: ["current_stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_current_stage_id_fkey"
            columns: ["current_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_current_stage_id_fkey"
            columns: ["current_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_suggested_stage_id_fkey"
            columns: ["suggested_stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_suggested_stage_id_fkey"
            columns: ["suggested_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_suggested_stage_id_fkey"
            columns: ["suggested_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_pending_stage_advances_transition_command_id_fkey"
            columns: ["transition_command_id"]
            isOneToOne: false
            referencedRelation: "deal_stage_transition_commands"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_processing_log: {
        Row: {
          attempts: number
          completed_at: string | null
          conversation_id: string
          last_error: string | null
          lease_expires_at: string | null
          lease_token: string | null
          message_id: string
          started_at: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          conversation_id: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          message_id: string
          started_at?: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          conversation_id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          message_id?: string
          started_at?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_processing_log_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_processing_log_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_processing_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_settings: {
        Row: {
          ai_avatar_emoji: string | null
          ai_name: string | null
          base_system_prompt: string
          created_at: string
          handoff_default_keywords: string[]
          hitl_auto_threshold: number
          hitl_reject_threshold: number
          max_response_blocks: number | null
          message_coalesce_window_ms: number | null
          model: string
          response_block_delay_ms: number | null
          send_mode: string
          tenant_id: string
          updated_at: string
          voice_id: string | null
          voice_model: string | null
          voice_reply_mode: string
        }
        Insert: {
          ai_avatar_emoji?: string | null
          ai_name?: string | null
          base_system_prompt?: string
          created_at?: string
          handoff_default_keywords?: string[]
          hitl_auto_threshold?: number
          hitl_reject_threshold?: number
          max_response_blocks?: number | null
          message_coalesce_window_ms?: number | null
          model?: string
          response_block_delay_ms?: number | null
          send_mode?: string
          tenant_id: string
          updated_at?: string
          voice_id?: string | null
          voice_model?: string | null
          voice_reply_mode?: string
        }
        Update: {
          ai_avatar_emoji?: string | null
          ai_name?: string | null
          base_system_prompt?: string
          created_at?: string
          handoff_default_keywords?: string[]
          hitl_auto_threshold?: number
          hitl_reject_threshold?: number
          max_response_blocks?: number | null
          message_coalesce_window_ms?: number | null
          model?: string
          response_block_delay_ms?: number | null
          send_mode?: string
          tenant_id?: string
          updated_at?: string
          voice_id?: string | null
          voice_model?: string | null
          voice_reply_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scopes: string[]
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scopes: string[]
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scopes?: string[]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      apify_enrichment_runs: {
        Row: {
          actor_id: string
          contact_id: string | null
          cost_usd: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          items_count: number
          run_id: string | null
          status: string
          tenant_id: string
          triggered_by: string | null
        }
        Insert: {
          actor_id: string
          contact_id?: string | null
          cost_usd?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          items_count?: number
          run_id?: string | null
          status?: string
          tenant_id: string
          triggered_by?: string | null
        }
        Update: {
          actor_id?: string
          contact_id?: string | null
          cost_usd?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          items_count?: number
          run_id?: string | null
          status?: string
          tenant_id?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "apify_enrichment_runs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "apify_enrichment_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "apify_enrichment_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          contact_id: string | null
          created_at: string
          created_by: string | null
          custom_fields: Json
          date: string
          external_ref: string | null
          external_source: string | null
          id: string
          modality: string
          notes: string | null
          status: string
          tenant_id: string
          time_end: string | null
          time_start: string
          title: string
          updated_at: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          custom_fields?: Json
          date: string
          external_ref?: string | null
          external_source?: string | null
          id?: string
          modality?: string
          notes?: string | null
          status?: string
          tenant_id: string
          time_end?: string | null
          time_start: string
          title: string
          updated_at?: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          custom_fields?: Json
          date?: string
          external_ref?: string | null
          external_source?: string | null
          id?: string
          modality?: string
          notes?: string | null
          status?: string
          tenant_id?: string
          time_end?: string | null
          time_start?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_webhook_events: {
        Row: {
          error: string | null
          event_type: string
          external_event_id: string
          id: string
          payload: Json
          processed_at: string | null
          provider: string
          received_at: string
          status: string
        }
        Insert: {
          error?: string | null
          event_type: string
          external_event_id: string
          id?: string
          payload: Json
          processed_at?: string | null
          provider: string
          received_at?: string
          status?: string
        }
        Update: {
          error?: string | null
          event_type?: string
          external_event_id?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          provider?: string
          received_at?: string
          status?: string
        }
        Relationships: []
      }
      board_stages: {
        Row: {
          board_id: string
          created_at: string
          id: string
          is_lost: boolean
          is_won: boolean
          max_attempts: number | null
          name: string
          position: number
          sla_business_days: boolean
          sla_days: number | null
          stage_key: string | null
          updated_at: string
        }
        Insert: {
          board_id: string
          created_at?: string
          id?: string
          is_lost?: boolean
          is_won?: boolean
          max_attempts?: number | null
          name: string
          position?: number
          sla_business_days?: boolean
          sla_days?: number | null
          stage_key?: string | null
          updated_at?: string
        }
        Update: {
          board_id?: string
          created_at?: string
          id?: string
          is_lost?: boolean
          is_won?: boolean
          max_attempts?: number | null
          name?: string
          position?: number
          sla_business_days?: boolean
          sla_days?: number | null
          stage_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "board_stages_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
        ]
      }
      boards: {
        Row: {
          automation_max_daily_transitions: number
          automation_mode: string
          automation_reversal_threshold: number
          board_key: string | null
          created_at: string
          goal_period: string | null
          goal_target: number | null
          id: string
          is_default: boolean
          name: string
          position: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          automation_max_daily_transitions?: number
          automation_mode?: string
          automation_reversal_threshold?: number
          board_key?: string | null
          created_at?: string
          goal_period?: string | null
          goal_target?: number | null
          id?: string
          is_default?: boolean
          name: string
          position?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          automation_max_daily_transitions?: number
          automation_mode?: string
          automation_reversal_threshold?: number
          board_key?: string | null
          created_at?: string
          goal_period?: string | null
          goal_target?: number | null
          id?: string
          is_default?: boolean
          name?: string
          position?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "boards_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      capability_catalog: {
        Row: {
          capability_key: string
          category: string
          created_at: string
          description: string | null
          is_active: boolean
          legacy_plugin_slug: string | null
          metadata: Json
          name: string
          updated_at: string
        }
        Insert: {
          capability_key: string
          category?: string
          created_at?: string
          description?: string | null
          is_active?: boolean
          legacy_plugin_slug?: string | null
          metadata?: Json
          name: string
          updated_at?: string
        }
        Update: {
          capability_key?: string
          category?: string
          created_at?: string
          description?: string | null
          is_active?: boolean
          legacy_plugin_slug?: string | null
          metadata?: Json
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      capability_shadow_evaluations: {
        Row: {
          bucket_start: string
          capability_key: string
          divergence: boolean
          last_evaluated_at: string
          legacy_allowed: boolean
          occurrences: number
          operation: string
          runtime_allowed: boolean
          tenant_id: string
        }
        Insert: {
          bucket_start: string
          capability_key: string
          divergence: boolean
          last_evaluated_at?: string
          legacy_allowed: boolean
          occurrences?: number
          operation: string
          runtime_allowed: boolean
          tenant_id: string
        }
        Update: {
          bucket_start?: string
          capability_key?: string
          divergence?: boolean
          last_evaluated_at?: string
          legacy_allowed?: boolean
          occurrences?: number
          operation?: string
          runtime_allowed?: boolean
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "capability_shadow_evaluations_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "capability_shadow_evaluations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_status_events: {
        Row: {
          channel_id: string
          created_at: string
          id: string
          raw: Json
          reason_code: string
          reason_detail: string | null
          run_id: string | null
          source: string
          status: string
          step: string | null
          step_state: string | null
          tenant_id: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          id?: string
          raw?: Json
          reason_code: string
          reason_detail?: string | null
          run_id?: string | null
          source: string
          status: string
          step?: string | null
          step_state?: string | null
          tenant_id: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          id?: string
          raw?: Json
          reason_code?: string
          reason_detail?: string | null
          run_id?: string | null
          source?: string
          status?: string
          step?: string | null
          step_state?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_status_events_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_status_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          config: Json
          created_at: string
          id: string
          last_connected_at: string | null
          last_status_reason: string | null
          provider_slug: string
          qr_code: string | null
          qr_code_expires_at: string | null
          status: string
          status_message: string | null
          tenant_id: string
          type: string
          updated_at: string
          webhook_consecutive_failures: number
          webhook_health: string | null
          webhook_health_checked_at: string | null
          webhook_token: string | null
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          last_connected_at?: string | null
          last_status_reason?: string | null
          provider_slug: string
          qr_code?: string | null
          qr_code_expires_at?: string | null
          status?: string
          status_message?: string | null
          tenant_id: string
          type: string
          updated_at?: string
          webhook_consecutive_failures?: number
          webhook_health?: string | null
          webhook_health_checked_at?: string | null
          webhook_token?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          last_connected_at?: string | null
          last_status_reason?: string | null
          provider_slug?: string
          qr_code?: string | null
          qr_code_expires_at?: string | null
          status?: string
          status_message?: string | null
          tenant_id?: string
          type?: string
          updated_at?: string
          webhook_consecutive_failures?: number
          webhook_health?: string | null
          webhook_health_checked_at?: string | null
          webhook_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "channels_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      communication_usage_events: {
        Row: {
          actual_cost_micros: number | null
          created_at: string
          currency: string
          estimated_cost_micros: number
          event_type: string
          id: string
          idempotency_key: string | null
          message_id: string | null
          metadata: Json
          occurred_at: string
          provider_slug: string
          tenant_id: string
          units: number
        }
        Insert: {
          actual_cost_micros?: number | null
          created_at?: string
          currency?: string
          estimated_cost_micros?: number
          event_type: string
          id?: string
          idempotency_key?: string | null
          message_id?: string | null
          metadata?: Json
          occurred_at?: string
          provider_slug: string
          tenant_id: string
          units?: number
        }
        Update: {
          actual_cost_micros?: number | null
          created_at?: string
          currency?: string
          estimated_cost_micros?: number
          event_type?: string
          id?: string
          idempotency_key?: string | null
          message_id?: string | null
          metadata?: Json
          occurred_at?: string
          provider_slug?: string
          tenant_id?: string
          units?: number
        }
        Relationships: [
          {
            foreignKeyName: "communication_usage_events_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communication_usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_enrichment_receipts: {
        Row: {
          contact_id: string
          enabled_at: string
          message_id: string
          processed_at: string | null
          tenant_id: string
        }
        Insert: {
          contact_id: string
          enabled_at: string
          message_id: string
          processed_at?: string | null
          tenant_id: string
        }
        Update: {
          contact_id?: string
          enabled_at?: string
          message_id?: string
          processed_at?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_enrichment_receipts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_enrichment_receipts_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_enrichment_receipts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_export_log: {
        Row: {
          created_at: string
          exported_by: string
          filters: Json
          id: string
          records_count: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          exported_by: string
          filters?: Json
          id?: string
          records_count: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          exported_by?: string
          filters?: Json
          id?: string
          records_count?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_export_log_exported_by_fkey"
            columns: ["exported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_export_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_extraction_queue: {
        Row: {
          contact_id: string
          created_at: string
          enabled_at: string | null
          id: string
          last_message_id: string | null
          last_processed_message_id: string | null
          last_started_at: string | null
          lease_token: string | null
          lease_until: string | null
          message_count: number
          next_run_at: string
          processing_enabled_at: string | null
          processing_message_ids: string[]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          enabled_at?: string | null
          id?: string
          last_message_id?: string | null
          last_processed_message_id?: string | null
          last_started_at?: string | null
          lease_token?: string | null
          lease_until?: string | null
          message_count?: number
          next_run_at?: string
          processing_enabled_at?: string | null
          processing_message_ids?: string[]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          enabled_at?: string | null
          id?: string
          last_message_id?: string | null
          last_processed_message_id?: string | null
          last_started_at?: string | null
          lease_token?: string | null
          lease_until?: string | null
          message_count?: number
          next_run_at?: string
          processing_enabled_at?: string | null
          processing_message_ids?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_extraction_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_extraction_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_field_edit_versions: {
        Row: {
          contact_id: string
          edited_at: string
          field_name: string
          field_type: string
          tenant_id: string
        }
        Insert: {
          contact_id: string
          edited_at: string
          field_name: string
          field_type: string
          tenant_id: string
        }
        Update: {
          contact_id?: string
          edited_at?: string
          field_name?: string
          field_type?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_field_edit_versions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_field_edit_versions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_field_extractions: {
        Row: {
          applied: boolean
          applied_at: string | null
          apply_reason: string | null
          confidence: number
          contact_id: string
          created_at: string
          extracted_value: string
          field_label: string | null
          field_name: string
          field_type: string
          id: string
          last_message_id: string | null
          model: string
          previous_value: string | null
          source_message_ids: string[]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          applied?: boolean
          applied_at?: string | null
          apply_reason?: string | null
          confidence: number
          contact_id: string
          created_at?: string
          extracted_value: string
          field_label?: string | null
          field_name: string
          field_type: string
          id?: string
          last_message_id?: string | null
          model: string
          previous_value?: string | null
          source_message_ids: string[]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          applied?: boolean
          applied_at?: string | null
          apply_reason?: string | null
          confidence?: number
          contact_id?: string
          created_at?: string
          extracted_value?: string
          field_label?: string | null
          field_name?: string
          field_type?: string
          id?: string
          last_message_id?: string | null
          model?: string
          previous_value?: string | null
          source_message_ids?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_field_extractions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_field_extractions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_identities: {
        Row: {
          contact_id: string
          created_at: string
          external_id: string
          id: string
          identity_type: string
          is_primary: boolean
          metadata: Json
          normalized_value: string
          provider_slug: string
          tenant_id: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          contact_id: string
          created_at?: string
          external_id: string
          id?: string
          identity_type: string
          is_primary?: boolean
          metadata?: Json
          normalized_value: string
          provider_slug?: string
          tenant_id: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          contact_id?: string
          created_at?: string
          external_id?: string
          id?: string
          identity_type?: string
          is_primary?: boolean
          metadata?: Json
          normalized_value?: string
          provider_slug?: string
          tenant_id?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contact_identities_contact_tenant_fk"
            columns: ["contact_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "contact_identities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_merge_log: {
        Row: {
          created_at: string
          id: string
          merged_by: string
          records_moved: Json
          source_contact_id: string
          source_snapshot: Json
          target_contact_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          merged_by: string
          records_moved: Json
          source_contact_id: string
          source_snapshot: Json
          target_contact_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          merged_by?: string
          records_moved?: Json
          source_contact_id?: string
          source_snapshot?: Json
          target_contact_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_merge_log_merged_by_fkey"
            columns: ["merged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_merge_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_notes: {
        Row: {
          contact_id: string
          content: string
          created_at: string
          created_by: string | null
          id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          contact_id: string
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          contact_id?: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_statuses: {
        Row: {
          color: string
          created_at: string
          id: string
          is_default: boolean
          label: string
          slug: string
          sort_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          is_default?: boolean
          label: string
          slug: string
          sort_order?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          is_default?: boolean
          label?: string
          slug?: string
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_statuses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          address_city: string | null
          address_country: string | null
          address_state: string | null
          address_street: string | null
          address_zip: string | null
          ai_memory: Json | null
          ai_paused: boolean
          avatar_url: string | null
          birthday: string | null
          client_origin:
            | Database["public"]["Enums"]["client_origin_type"]
            | null
          company_id: string | null
          created_at: string
          current_supplier: string | null
          custom_fields: Json
          deleted_at: string | null
          department: string | null
          description: string | null
          email: string | null
          follow_up_owner_id: string | null
          id: string
          instagram: string | null
          job_title: string | null
          lead_origin: Database["public"]["Enums"]["lead_origin_type"] | null
          linkedin: string | null
          merged_into_id: string | null
          monthly_volume_kg: number | null
          name: string
          notes: string | null
          opened_by: string | null
          out_of_area: boolean
          out_of_area_at: string | null
          out_of_area_note: string | null
          owner_id: string | null
          phone: string | null
          portfolio_owner_id: string | null
          portfolio_transferred_at: string | null
          products_interest: string[]
          region_id: string | null
          segment: Database["public"]["Enums"]["customer_segment_type"] | null
          source: string | null
          status: string
          tags: string[]
          tenant_id: string
          updated_at: string
          website: string | null
        }
        Insert: {
          address_city?: string | null
          address_country?: string | null
          address_state?: string | null
          address_street?: string | null
          address_zip?: string | null
          ai_memory?: Json | null
          ai_paused?: boolean
          avatar_url?: string | null
          birthday?: string | null
          client_origin?:
            | Database["public"]["Enums"]["client_origin_type"]
            | null
          company_id?: string | null
          created_at?: string
          current_supplier?: string | null
          custom_fields?: Json
          deleted_at?: string | null
          department?: string | null
          description?: string | null
          email?: string | null
          follow_up_owner_id?: string | null
          id?: string
          instagram?: string | null
          job_title?: string | null
          lead_origin?: Database["public"]["Enums"]["lead_origin_type"] | null
          linkedin?: string | null
          merged_into_id?: string | null
          monthly_volume_kg?: number | null
          name: string
          notes?: string | null
          opened_by?: string | null
          out_of_area?: boolean
          out_of_area_at?: string | null
          out_of_area_note?: string | null
          owner_id?: string | null
          phone?: string | null
          portfolio_owner_id?: string | null
          portfolio_transferred_at?: string | null
          products_interest?: string[]
          region_id?: string | null
          segment?: Database["public"]["Enums"]["customer_segment_type"] | null
          source?: string | null
          status?: string
          tags?: string[]
          tenant_id: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          address_city?: string | null
          address_country?: string | null
          address_state?: string | null
          address_street?: string | null
          address_zip?: string | null
          ai_memory?: Json | null
          ai_paused?: boolean
          avatar_url?: string | null
          birthday?: string | null
          client_origin?:
            | Database["public"]["Enums"]["client_origin_type"]
            | null
          company_id?: string | null
          created_at?: string
          current_supplier?: string | null
          custom_fields?: Json
          deleted_at?: string | null
          department?: string | null
          description?: string | null
          email?: string | null
          follow_up_owner_id?: string | null
          id?: string
          instagram?: string | null
          job_title?: string | null
          lead_origin?: Database["public"]["Enums"]["lead_origin_type"] | null
          linkedin?: string | null
          merged_into_id?: string | null
          monthly_volume_kg?: number | null
          name?: string
          notes?: string | null
          opened_by?: string | null
          out_of_area?: boolean
          out_of_area_at?: string | null
          out_of_area_note?: string | null
          owner_id?: string | null
          phone?: string | null
          portfolio_owner_id?: string | null
          portfolio_transferred_at?: string | null
          products_interest?: string[]
          region_id?: string | null
          segment?: Database["public"]["Enums"]["customer_segment_type"] | null
          source?: string | null
          status?: string
          tags?: string[]
          tenant_id?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_company_id_tenant_fkey"
            columns: ["tenant_id", "company_id"]
            isOneToOne: false
            referencedRelation: "crm_companies"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "contacts_follow_up_owner_id_fkey"
            columns: ["follow_up_owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_portfolio_owner_id_fkey"
            columns: ["portfolio_owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "service_regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_status_catalog_fk"
            columns: ["tenant_id", "status"]
            isOneToOne: false
            referencedRelation: "contact_statuses"
            referencedColumns: ["tenant_id", "slug"]
          },
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          ai_active: boolean
          ai_lock_token: string | null
          ai_lock_until: string | null
          ai_resumed_at: string | null
          awaiting_human: boolean
          awaiting_human_since: string | null
          channel_id: string
          contact_id: string
          created_at: string
          deleted_at: string | null
          handoff_activity_id: string | null
          id: string
          last_error: Json | null
          last_message_at: string | null
          status: string
          subject: string | null
          tenant_id: string
          unread_count: number
          updated_at: string
        }
        Insert: {
          ai_active?: boolean
          ai_lock_token?: string | null
          ai_lock_until?: string | null
          ai_resumed_at?: string | null
          awaiting_human?: boolean
          awaiting_human_since?: string | null
          channel_id: string
          contact_id: string
          created_at?: string
          deleted_at?: string | null
          handoff_activity_id?: string | null
          id?: string
          last_error?: Json | null
          last_message_at?: string | null
          status?: string
          subject?: string | null
          tenant_id: string
          unread_count?: number
          updated_at?: string
        }
        Update: {
          ai_active?: boolean
          ai_lock_token?: string | null
          ai_lock_until?: string | null
          ai_resumed_at?: string | null
          awaiting_human?: boolean
          awaiting_human_since?: string | null
          channel_id?: string
          contact_id?: string
          created_at?: string
          deleted_at?: string | null
          handoff_activity_id?: string | null
          id?: string
          last_error?: Json | null
          last_message_at?: string | null
          status?: string
          subject?: string | null
          tenant_id?: string
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_handoff_activity_id_fkey"
            columns: ["handoff_activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_companies: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          industry: string | null
          name: string
          owner_id: string | null
          tenant_id: string
          updated_at: string
          website: string | null
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          industry?: string | null
          name: string
          owner_id?: string | null
          tenant_id: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          industry?: string | null
          name?: string
          owner_id?: string | null
          tenant_id?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_companies_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_companies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_products: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          duration_minutes: number | null
          id: string
          name: string
          price: number | null
          sku: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          name: string
          price?: number | null
          sku?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          name?: string
          price?: number | null
          sku?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_field_definitions: {
        Row: {
          created_at: string
          entity: string
          field_type: string
          id: string
          key: string
          label: string
          options: Json
          position: number
          required: boolean
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          entity: string
          field_type: string
          id?: string
          key: string
          label: string
          options?: Json
          position?: number
          required?: boolean
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          entity?: string
          field_type?: string
          id?: string
          key?: string
          label?: string
          options?: Json
          position?: number
          required?: boolean
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_field_definitions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_followups: {
        Row: {
          ai_suggested: boolean
          completed_at: string | null
          completed_by: string | null
          contact_id: string
          created_at: string
          created_by: string
          deal_id: string | null
          description: string | null
          id: string
          scheduled_at: string
          source: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          ai_suggested?: boolean
          completed_at?: string | null
          completed_by?: string | null
          contact_id: string
          created_at?: string
          created_by: string
          deal_id?: string | null
          description?: string | null
          id?: string
          scheduled_at: string
          source?: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          ai_suggested?: boolean
          completed_at?: string | null
          completed_by?: string | null
          contact_id?: string
          created_at?: string
          created_by?: string
          deal_id?: string | null
          description?: string | null
          id?: string
          scheduled_at?: string
          source?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_followups_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_followups_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_followups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_followups_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "deal_followups_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_followups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_qualification_snapshots: {
        Row: {
          alerts: Json
          based_on_messages: number
          confidence: number
          deal_id: string
          dimensions: Json
          executive_summary: string
          generated_at: string
          id: string
          pending_points: Json
          recommended_approach: Json
          tenant_id: string
        }
        Insert: {
          alerts?: Json
          based_on_messages: number
          confidence: number
          deal_id: string
          dimensions: Json
          executive_summary: string
          generated_at?: string
          id?: string
          pending_points?: Json
          recommended_approach: Json
          tenant_id: string
        }
        Update: {
          alerts?: Json
          based_on_messages?: number
          confidence?: number
          deal_id?: string
          dimensions?: Json
          executive_summary?: string
          generated_at?: string
          id?: string
          pending_points?: Json
          recommended_approach?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_qualification_snapshots_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "deal_qualification_snapshots_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_qualification_snapshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_stage_evaluations: {
        Row: {
          confidence: number
          criterion_key: string
          criterion_label: string
          deal_id: string
          evaluated_at: string
          evidence: string | null
          expires_at: string | null
          human_feedback: string | null
          id: string
          model_version: string | null
          source_event_id: string | null
          stage_id: string
          status: string
          structured_signals: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          confidence?: number
          criterion_key: string
          criterion_label: string
          deal_id: string
          evaluated_at?: string
          evidence?: string | null
          expires_at?: string | null
          human_feedback?: string | null
          id?: string
          model_version?: string | null
          source_event_id?: string | null
          stage_id: string
          status: string
          structured_signals?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          confidence?: number
          criterion_key?: string
          criterion_label?: string
          deal_id?: string
          evaluated_at?: string
          evidence?: string | null
          expires_at?: string | null
          human_feedback?: string | null
          id?: string
          model_version?: string | null
          source_event_id?: string | null
          stage_id?: string
          status?: string
          structured_signals?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_stage_evaluations_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "deal_stage_evaluations_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_stage_evaluations_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_stage_evaluations_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "deal_stage_evaluations_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "deal_stage_evaluations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_stage_history: {
        Row: {
          actor_id: string | null
          actor_type: string | null
          changed_by_automation: boolean
          changed_by_user_id: string | null
          confidence: number | null
          correlation_id: string | null
          created_at: string
          criteria_evaluation: Json | null
          deal_id: string
          decision: string | null
          evidence: Json | null
          from_stage_id: string | null
          id: string
          idempotency_key: string | null
          model_version: string | null
          policy_snapshot: Json | null
          prompt_snapshot: Json | null
          reason: string | null
          reversal_of_history_id: string | null
          reversal_reason: string | null
          tenant_id: string
          to_stage_id: string | null
          transition_command_id: string | null
          trigger_event: string | null
        }
        Insert: {
          actor_id?: string | null
          actor_type?: string | null
          changed_by_automation?: boolean
          changed_by_user_id?: string | null
          confidence?: number | null
          correlation_id?: string | null
          created_at?: string
          criteria_evaluation?: Json | null
          deal_id: string
          decision?: string | null
          evidence?: Json | null
          from_stage_id?: string | null
          id?: string
          idempotency_key?: string | null
          model_version?: string | null
          policy_snapshot?: Json | null
          prompt_snapshot?: Json | null
          reason?: string | null
          reversal_of_history_id?: string | null
          reversal_reason?: string | null
          tenant_id: string
          to_stage_id?: string | null
          transition_command_id?: string | null
          trigger_event?: string | null
        }
        Update: {
          actor_id?: string | null
          actor_type?: string | null
          changed_by_automation?: boolean
          changed_by_user_id?: string | null
          confidence?: number | null
          correlation_id?: string | null
          created_at?: string
          criteria_evaluation?: Json | null
          deal_id?: string
          decision?: string | null
          evidence?: Json | null
          from_stage_id?: string | null
          id?: string
          idempotency_key?: string | null
          model_version?: string | null
          policy_snapshot?: Json | null
          prompt_snapshot?: Json | null
          reason?: string | null
          reversal_of_history_id?: string | null
          reversal_reason?: string | null
          tenant_id?: string
          to_stage_id?: string | null
          transition_command_id?: string | null
          trigger_event?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deal_stage_history_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "deal_stage_history_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_stage_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_stage_history_transition_command_id_fkey"
            columns: ["transition_command_id"]
            isOneToOne: false
            referencedRelation: "deal_stage_transition_commands"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_stage_transition_commands: {
        Row: {
          actor_id: string | null
          actor_type: string
          board_id: string
          completed_at: string | null
          confidence: number | null
          correlation_id: string | null
          created_at: string
          criteria_evaluation: Json
          deal_id: string
          decision: string
          evidence: Json
          evidence_hash: string | null
          expected_stage_id: string
          id: string
          idempotency_key: string
          model_version: string | null
          policy_snapshot: Json
          prompt_snapshot: Json | null
          reason: string | null
          result: Json
          reversal_of_history_id: string | null
          status: string
          target_stage_id: string
          tenant_id: string
          transition_id: string | null
          trigger_event: string | null
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          board_id: string
          completed_at?: string | null
          confidence?: number | null
          correlation_id?: string | null
          created_at?: string
          criteria_evaluation?: Json
          deal_id: string
          decision?: string
          evidence?: Json
          evidence_hash?: string | null
          expected_stage_id: string
          id?: string
          idempotency_key: string
          model_version?: string | null
          policy_snapshot?: Json
          prompt_snapshot?: Json | null
          reason?: string | null
          result?: Json
          reversal_of_history_id?: string | null
          status?: string
          target_stage_id: string
          tenant_id: string
          transition_id?: string | null
          trigger_event?: string | null
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          board_id?: string
          completed_at?: string | null
          confidence?: number | null
          correlation_id?: string | null
          created_at?: string
          criteria_evaluation?: Json
          deal_id?: string
          decision?: string
          evidence?: Json
          evidence_hash?: string | null
          expected_stage_id?: string
          id?: string
          idempotency_key?: string
          model_version?: string | null
          policy_snapshot?: Json
          prompt_snapshot?: Json | null
          reason?: string | null
          result?: Json
          reversal_of_history_id?: string | null
          status?: string
          target_stage_id?: string
          tenant_id?: string
          transition_id?: string | null
          trigger_event?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deal_stage_transition_commands_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_stage_transition_commands_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "deal_stage_transition_commands_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_stage_transition_commands_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deal_stage_transition_commands_transition_id_fkey"
            columns: ["transition_id"]
            isOneToOne: false
            referencedRelation: "stage_transitions"
            referencedColumns: ["id"]
          },
        ]
      }
      deals: {
        Row: {
          ai_transition_count_24h: number
          ai_transition_window_started_at: string | null
          automation_last_evidence_hash: string | null
          automation_lock_reason: string | null
          automation_mode: string
          automation_paused_until: string | null
          board_id: string
          closed_at: string | null
          contact_attempts: number
          contact_id: string | null
          created_at: string
          custom_fields: Json
          first_delivery_at: string | null
          first_order_at: string | null
          first_order_mix: string[]
          first_order_value: number | null
          id: string
          last_ai_transition_at: string | null
          lost_reason: string | null
          lost_reason_code:
            | Database["public"]["Enums"]["lost_reason_code_type"]
            | null
          nurture_return_at: string | null
          owner_id: string | null
          sample_delivered_at: string | null
          sample_requested: boolean
          sample_status:
            | Database["public"]["Enums"]["sample_status_type"]
            | null
          second_order_at: string | null
          source_deal_id: string | null
          stage_due_at: string | null
          stage_entered_at: string
          stage_id: string
          status: string
          tenant_id: string
          title: string
          updated_at: string
          value: number | null
        }
        Insert: {
          ai_transition_count_24h?: number
          ai_transition_window_started_at?: string | null
          automation_last_evidence_hash?: string | null
          automation_lock_reason?: string | null
          automation_mode?: string
          automation_paused_until?: string | null
          board_id: string
          closed_at?: string | null
          contact_attempts?: number
          contact_id?: string | null
          created_at?: string
          custom_fields?: Json
          first_delivery_at?: string | null
          first_order_at?: string | null
          first_order_mix?: string[]
          first_order_value?: number | null
          id?: string
          last_ai_transition_at?: string | null
          lost_reason?: string | null
          lost_reason_code?:
            | Database["public"]["Enums"]["lost_reason_code_type"]
            | null
          nurture_return_at?: string | null
          owner_id?: string | null
          sample_delivered_at?: string | null
          sample_requested?: boolean
          sample_status?:
            | Database["public"]["Enums"]["sample_status_type"]
            | null
          second_order_at?: string | null
          source_deal_id?: string | null
          stage_due_at?: string | null
          stage_entered_at?: string
          stage_id: string
          status?: string
          tenant_id: string
          title: string
          updated_at?: string
          value?: number | null
        }
        Update: {
          ai_transition_count_24h?: number
          ai_transition_window_started_at?: string | null
          automation_last_evidence_hash?: string | null
          automation_lock_reason?: string | null
          automation_mode?: string
          automation_paused_until?: string | null
          board_id?: string
          closed_at?: string | null
          contact_attempts?: number
          contact_id?: string | null
          created_at?: string
          custom_fields?: Json
          first_delivery_at?: string | null
          first_order_at?: string | null
          first_order_mix?: string[]
          first_order_value?: number | null
          id?: string
          last_ai_transition_at?: string | null
          lost_reason?: string | null
          lost_reason_code?:
            | Database["public"]["Enums"]["lost_reason_code_type"]
            | null
          nurture_return_at?: string | null
          owner_id?: string | null
          sample_delivered_at?: string | null
          sample_requested?: boolean
          sample_status?:
            | Database["public"]["Enums"]["sample_status_type"]
            | null
          second_order_at?: string | null
          source_deal_id?: string | null
          stage_due_at?: string | null
          stage_entered_at?: string
          stage_id?: string
          status?: string
          tenant_id?: string
          title?: string
          updated_at?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_source_deal_id_fkey"
            columns: ["source_deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "deals_source_deal_id_fkey"
            columns: ["source_deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "deals_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_event_projections: {
        Row: {
          aggregate_id: string
          aggregate_type: string
          event_id: string
          event_type: string
          projected_at: string
          schema_version: number
          subscriber_id: string
          tenant_id: string | null
        }
        Insert: {
          aggregate_id: string
          aggregate_type: string
          event_id: string
          event_type: string
          projected_at?: string
          schema_version: number
          subscriber_id: string
          tenant_id?: string | null
        }
        Update: {
          aggregate_id?: string
          aggregate_type?: string
          event_id?: string
          event_type?: string
          projected_at?: string
          schema_version?: number
          subscriber_id?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "domain_event_projections_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "domain_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "domain_event_projections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_event_subscriptions: {
        Row: {
          active: boolean
          created_at: string
          event_types: string[]
          max_attempts: number
          subscriber_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          event_types: string[]
          max_attempts?: number
          subscriber_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          event_types?: string[]
          max_attempts?: number
          subscriber_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      domain_events: {
        Row: {
          aggregate_id: string
          aggregate_type: string
          created_at: string
          event_type: string
          id: string
          idempotency_key: string
          metadata: Json
          occurred_at: string
          payload: Json
          schema_version: number
          tenant_id: string | null
        }
        Insert: {
          aggregate_id: string
          aggregate_type: string
          created_at?: string
          event_type: string
          id?: string
          idempotency_key: string
          metadata?: Json
          occurred_at?: string
          payload?: Json
          schema_version?: number
          tenant_id?: string | null
        }
        Update: {
          aggregate_id?: string
          aggregate_type?: string
          created_at?: string
          event_type?: string
          id?: string
          idempotency_key?: string
          metadata?: Json
          occurred_at?: string
          payload?: Json
          schema_version?: number
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "domain_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      entitlement_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: string | null
          correlation_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          id: number
          new_data: Json | null
          old_data: Json | null
          tenant_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role?: string | null
          correlation_id?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          tenant_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: string | null
          correlation_id?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entitlement_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      event_deliveries: {
        Row: {
          attempts: number
          available_at: string
          created_at: string
          delivered_at: string | null
          event_id: string
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          status: string
          subscriber_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          available_at?: string
          created_at?: string
          delivered_at?: string | null
          event_id: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts: number
          status?: string
          subscriber_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          available_at?: string
          created_at?: string
          delivered_at?: string | null
          event_id?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          status?: string
          subscriber_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_deliveries_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "domain_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_deliveries_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "domain_event_subscriptions"
            referencedColumns: ["subscriber_id"]
          },
          {
            foreignKeyName: "event_deliveries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      feegow_sync_log: {
        Row: {
          created_at: string
          error_detail: string | null
          id: string
          run_at: string
          status: string
          synced_count: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          error_detail?: string | null
          id?: string
          run_at?: string
          status: string
          synced_count?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          error_detail?: string | null
          id?: string
          run_at?: string
          status?: string
          synced_count?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feegow_sync_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hitl_audit_log: {
        Row: {
          actor_id: string | null
          actor_type: string
          created_at: string
          event: string
          execution_error: string | null
          execution_result: Json | null
          id: string
          modifications: Json | null
          new_status: string | null
          previous_status: string | null
          reason: string | null
          subject_id: string
          subject_type: string
          tenant_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          event: string
          execution_error?: string | null
          execution_result?: Json | null
          id?: string
          modifications?: Json | null
          new_status?: string | null
          previous_status?: string | null
          reason?: string | null
          subject_id: string
          subject_type: string
          tenant_id: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          event?: string
          execution_error?: string | null
          execution_result?: Json | null
          id?: string
          modifications?: Json | null
          new_status?: string | null
          previous_status?: string | null
          reason?: string | null
          subject_id?: string
          subject_type?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hitl_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hitl_decisions: {
        Row: {
          activity_id: string | null
          alternative_actions: Json | null
          auto_generated: boolean
          category: string
          contact_id: string | null
          created_at: string
          deal_id: string | null
          decided_at: string | null
          decided_by: string | null
          description: string | null
          expires_at: string | null
          id: string
          modifications: Json | null
          priority: string
          reasoning: string | null
          reject_reason: string | null
          snooze_until: string | null
          status: string
          suggested_action: Json
          tenant_id: string
          title: string
          type: string
        }
        Insert: {
          activity_id?: string | null
          alternative_actions?: Json | null
          auto_generated?: boolean
          category: string
          contact_id?: string | null
          created_at?: string
          deal_id?: string | null
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          modifications?: Json | null
          priority: string
          reasoning?: string | null
          reject_reason?: string | null
          snooze_until?: string | null
          status?: string
          suggested_action?: Json
          tenant_id: string
          title: string
          type: string
        }
        Update: {
          activity_id?: string | null
          alternative_actions?: Json | null
          auto_generated?: boolean
          category?: string
          contact_id?: string | null
          created_at?: string
          deal_id?: string | null
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          expires_at?: string | null
          id?: string
          modifications?: Json | null
          priority?: string
          reasoning?: string | null
          reject_reason?: string | null
          snooze_until?: string | null
          status?: string
          suggested_action?: Json
          tenant_id?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "hitl_decisions_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_decisions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_decisions_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "hitl_decisions_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hitl_handoff_sla_events: {
        Row: {
          activity_id: string | null
          awaiting_human_since: string
          conversation_id: string
          created_at: string
          id: string
          resolved_at: string | null
          resolved_by: string | null
          sla_alerted_at: string | null
          tenant_id: string
        }
        Insert: {
          activity_id?: string | null
          awaiting_human_since: string
          conversation_id: string
          created_at?: string
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          sla_alerted_at?: string | null
          tenant_id: string
        }
        Update: {
          activity_id?: string | null
          awaiting_human_since?: string
          conversation_id?: string
          created_at?: string
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          sla_alerted_at?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hitl_handoff_sla_events_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_handoff_sla_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_handoff_sla_events_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hitl_handoff_sla_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_events: {
        Row: {
          action_taken: string | null
          attempts: number
          deal_id: string | null
          duplicate_count: number
          error_code: string | null
          external_event_id: string
          extracted: Json | null
          id: string
          last_duplicate_at: string | null
          processed_at: string | null
          received_at: string
          rule_id: string
          status: string
          tenant_id: string
        }
        Insert: {
          action_taken?: string | null
          attempts?: number
          deal_id?: string | null
          duplicate_count?: number
          error_code?: string | null
          external_event_id: string
          extracted?: Json | null
          id?: string
          last_duplicate_at?: string | null
          processed_at?: string | null
          received_at?: string
          rule_id: string
          status?: string
          tenant_id: string
        }
        Update: {
          action_taken?: string | null
          attempts?: number
          deal_id?: string | null
          duplicate_count?: number
          error_code?: string | null
          external_event_id?: string
          extracted?: Json | null
          id?: string
          last_duplicate_at?: string | null
          processed_at?: string | null
          received_at?: string
          rule_id?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_events_rule_id_tenant_id_fkey"
            columns: ["rule_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "inbound_rules"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "inbound_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_rules: {
        Row: {
          action: string
          action_config: Json
          active: boolean
          allowed_stage_ids: string[]
          board_id: string
          conditions: Json
          created_at: string
          created_by: string | null
          disabled_reason: string | null
          event_id_path: string
          id: string
          ignored_count: number
          last_ignored_at: string | null
          last_ignored_reason: string | null
          match_custom_field_key: string | null
          match_field: string
          match_path: string
          max_actions_per_day: number
          max_actions_per_minute: number
          name: string
          not_found_mode: string
          previous_secret_expires_at: string | null
          previous_vault_secret_id: string | null
          reactivated_at: string | null
          tenant_id: string
          token_header_name: string | null
          updated_at: string
          vault_secret_id: string | null
          verification_mode: string
        }
        Insert: {
          action: string
          action_config: Json
          active?: boolean
          allowed_stage_ids: string[]
          board_id: string
          conditions?: Json
          created_at?: string
          created_by?: string | null
          disabled_reason?: string | null
          event_id_path: string
          id?: string
          ignored_count?: number
          last_ignored_at?: string | null
          last_ignored_reason?: string | null
          match_custom_field_key?: string | null
          match_field: string
          match_path: string
          max_actions_per_day?: number
          max_actions_per_minute?: number
          name: string
          not_found_mode?: string
          previous_secret_expires_at?: string | null
          previous_vault_secret_id?: string | null
          reactivated_at?: string | null
          tenant_id: string
          token_header_name?: string | null
          updated_at?: string
          vault_secret_id?: string | null
          verification_mode: string
        }
        Update: {
          action?: string
          action_config?: Json
          active?: boolean
          allowed_stage_ids?: string[]
          board_id?: string
          conditions?: Json
          created_at?: string
          created_by?: string | null
          disabled_reason?: string | null
          event_id_path?: string
          id?: string
          ignored_count?: number
          last_ignored_at?: string | null
          last_ignored_reason?: string | null
          match_custom_field_key?: string | null
          match_field?: string
          match_path?: string
          max_actions_per_day?: number
          max_actions_per_minute?: number
          name?: string
          not_found_mode?: string
          previous_secret_expires_at?: string | null
          previous_vault_secret_id?: string | null
          reactivated_at?: string | null
          tenant_id?: string
          token_header_name?: string | null
          updated_at?: string
          vault_secret_id?: string | null
          verification_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_rules_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_secrets: {
        Row: {
          created_at: string
          key: string
          slug: string
          tenant_id: string
          updated_at: string
          value: string
        }
        Insert: {
          created_at?: string
          key: string
          slug: string
          tenant_id: string
          updated_at?: string
          value: string
        }
        Update: {
          created_at?: string
          key?: string
          slug?: string
          tenant_id?: string
          updated_at?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          available: boolean
          category: string
          created_at: string
          description: string | null
          icon: string | null
          name: string
          required_secrets: Json
          setup_steps: Json
          slug: string
          updated_at: string
        }
        Insert: {
          available?: boolean
          category: string
          created_at?: string
          description?: string | null
          icon?: string | null
          name: string
          required_secrets?: Json
          setup_steps?: Json
          slug: string
          updated_at?: string
        }
        Update: {
          available?: boolean
          category?: string
          created_at?: string
          description?: string | null
          icon?: string | null
          name?: string
          required_secrets?: Json
          setup_steps?: Json
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          created_by: string | null
          email: string
          expires_at: string
          id: string
          role: string
          tenant_id: string
          token: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          created_by?: string | null
          email: string
          expires_at?: string
          id?: string
          role?: string
          tenant_id: string
          token?: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          created_by?: string | null
          email?: string
          expires_at?: string
          id?: string
          role?: string
          tenant_id?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invites_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invites_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      job_queue: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          job_type: string
          max_attempts: number
          payload: Json
          scheduled_for: string
          started_at: string | null
          status: string
          tenant_id: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          job_type: string
          max_attempts?: number
          payload?: Json
          scheduled_for?: string
          started_at?: string | null
          status?: string
          tenant_id?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          job_type?: string
          max_attempts?: number
          payload?: Json
          scheduled_for?: string
          started_at?: string | null
          status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          document_id: string
          embedding: string
          id: string
          tenant_id: string
          token_count: number
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          document_id: string
          embedding: string
          id?: string
          tenant_id: string
          token_count: number
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string
          id?: string
          tenant_id?: string
          token_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "kb_chunks_document_same_tenant"
            columns: ["document_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "kb_documents"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "kb_chunks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_documents: {
        Row: {
          bytes: number
          chunk_count: number
          content_hash: string
          created_at: string
          created_by: string | null
          error_message: string | null
          file_name: string | null
          id: string
          mime_type: string
          remote_file_id: string | null
          remote_job_id: string | null
          remote_provider: string | null
          source_base64: string | null
          source_text: string | null
          source_type: string
          status: string
          storage_path: string | null
          tenant_id: string
          title: string
          updated_at: string
        }
        Insert: {
          bytes: number
          chunk_count?: number
          content_hash: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          file_name?: string | null
          id?: string
          mime_type: string
          remote_file_id?: string | null
          remote_job_id?: string | null
          remote_provider?: string | null
          source_base64?: string | null
          source_text?: string | null
          source_type: string
          status?: string
          storage_path?: string | null
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          bytes?: number
          chunk_count?: number
          content_hash?: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          file_name?: string | null
          id?: string
          mime_type?: string
          remote_file_id?: string | null
          remote_job_id?: string | null
          remote_provider?: string | null
          source_base64?: string | null
          source_text?: string | null
          source_type?: string
          status?: string
          storage_path?: string | null
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_form_submissions: {
        Row: {
          contact_id: string | null
          created_at: string
          data: Json
          id: string
          lead_form_id: string
          source_ip: unknown
          tenant_id: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          data?: Json
          id?: string
          lead_form_id: string
          source_ip?: unknown
          tenant_id: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          data?: Json
          id?: string
          lead_form_id?: string
          source_ip?: unknown
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_form_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_form_submissions_lead_form_id_fkey"
            columns: ["lead_form_id"]
            isOneToOne: false
            referencedRelation: "lead_forms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_form_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_forms: {
        Row: {
          created_at: string
          fields: Json
          id: string
          is_active: boolean
          name: string
          slug: string
          success_message: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          fields?: Json
          id?: string
          is_active?: boolean
          name: string
          slug: string
          success_message?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          fields?: Json
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          success_message?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_forms_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_spend: {
        Row: {
          amount: number
          channel: string
          created_at: string
          id: string
          month: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount?: number
          channel?: string
          created_at?: string
          id?: string
          month: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          channel?: string
          created_at?: string
          id?: string
          month?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_spend_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_engine_capabilities: {
        Row: {
          capability_key: string
          engine_id: string
        }
        Insert: {
          capability_key: string
          engine_id: string
        }
        Update: {
          capability_key?: string
          engine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_engine_capabilities_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "marketplace_engine_capabilities_engine_id_fkey"
            columns: ["engine_id"]
            isOneToOne: false
            referencedRelation: "marketplace_engine_catalog"
            referencedColumns: ["engine_id"]
          },
        ]
      }
      marketplace_engine_catalog: {
        Row: {
          created_at: string
          engine_id: string
          is_active: boolean
          legacy_plugin: string | null
          lifecycle_handlers: Json
          name: string
          publisher: string
          required_entitlement: string
          updated_at: string
          version: string
        }
        Insert: {
          created_at?: string
          engine_id: string
          is_active?: boolean
          legacy_plugin?: string | null
          lifecycle_handlers?: Json
          name: string
          publisher?: string
          required_entitlement: string
          updated_at?: string
          version: string
        }
        Update: {
          created_at?: string
          engine_id?: string
          is_active?: boolean
          legacy_plugin?: string | null
          lifecycle_handlers?: Json
          name?: string
          publisher?: string
          required_entitlement?: string
          updated_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_engine_catalog_required_entitlement_fkey"
            columns: ["required_entitlement"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
        ]
      }
      marketplace_engine_dependencies: {
        Row: {
          depends_on_engine_id: string
          engine_id: string
          minimum_version: string | null
          optional: boolean
        }
        Insert: {
          depends_on_engine_id: string
          engine_id: string
          minimum_version?: string | null
          optional?: boolean
        }
        Update: {
          depends_on_engine_id?: string
          engine_id?: string
          minimum_version?: string | null
          optional?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_engine_dependencies_depends_on_engine_id_fkey"
            columns: ["depends_on_engine_id"]
            isOneToOne: false
            referencedRelation: "marketplace_engine_catalog"
            referencedColumns: ["engine_id"]
          },
          {
            foreignKeyName: "marketplace_engine_dependencies_engine_id_fkey"
            columns: ["engine_id"]
            isOneToOne: false
            referencedRelation: "marketplace_engine_catalog"
            referencedColumns: ["engine_id"]
          },
        ]
      }
      membership_audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          after_state: Json | null
          before_state: Json | null
          created_at: string
          id: string
          membership_id: string | null
          tenant_id: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: string
          membership_id?: string | null
          tenant_id: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: string
          membership_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_audit_log_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "tenant_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          audio_attempts: number
          audio_bytes: number | null
          audio_error: string | null
          audio_generated_at: string | null
          audio_sent_at: string | null
          audio_status: string
          audio_storage_path: string | null
          content: string | null
          conversation_id: string
          created_at: string
          delivered_at: string | null
          direction: string
          external_id: string | null
          id: string
          last_attempt_error: string | null
          media_type: string | null
          media_url: string | null
          metadata: Json
          provider_status_at: string | null
          read_at: string | null
          send_attempts: number
          send_error: string | null
          sender: string
          status: string
          tenant_id: string
        }
        Insert: {
          audio_attempts?: number
          audio_bytes?: number | null
          audio_error?: string | null
          audio_generated_at?: string | null
          audio_sent_at?: string | null
          audio_status?: string
          audio_storage_path?: string | null
          content?: string | null
          conversation_id: string
          created_at?: string
          delivered_at?: string | null
          direction: string
          external_id?: string | null
          id?: string
          last_attempt_error?: string | null
          media_type?: string | null
          media_url?: string | null
          metadata?: Json
          provider_status_at?: string | null
          read_at?: string | null
          send_attempts?: number
          send_error?: string | null
          sender: string
          status?: string
          tenant_id: string
        }
        Update: {
          audio_attempts?: number
          audio_bytes?: number | null
          audio_error?: string | null
          audio_generated_at?: string | null
          audio_sent_at?: string | null
          audio_status?: string
          audio_storage_path?: string | null
          content?: string | null
          conversation_id?: string
          created_at?: string
          delivered_at?: string | null
          direction?: string
          external_id?: string | null
          id?: string
          last_attempt_error?: string | null
          media_type?: string | null
          media_url?: string | null
          metadata?: Json
          provider_status_at?: string | null
          read_at?: string | null
          send_attempts?: number
          send_error?: string | null
          sender?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      messaging_phone_suppressions: {
        Row: {
          contact_id: string | null
          id: string
          metadata: Json
          phone: string
          reactivated_at: string | null
          reason: string
          scope: string
          source: string
          suppressed_at: string
          tenant_id: string
        }
        Insert: {
          contact_id?: string | null
          id?: string
          metadata?: Json
          phone: string
          reactivated_at?: string | null
          reason: string
          scope?: string
          source?: string
          suppressed_at?: string
          tenant_id: string
        }
        Update: {
          contact_id?: string | null
          id?: string
          metadata?: Json
          phone?: string
          reactivated_at?: string | null
          reason?: string
          scope?: string
          source?: string
          suppressed_at?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messaging_phone_suppressions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_phone_suppressions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      messaging_templates: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          body: string
          channel_id: string | null
          created_at: string
          created_by: string | null
          id: string
          is_draft: boolean
          kind: string
          language: string
          name: string
          parent_id: string | null
          provider_template_name: string | null
          status: string
          tags: string[] | null
          tenant_id: string
          updated_at: string
          variables: Json | null
          version: number
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          body: string
          channel_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_draft?: boolean
          kind?: string
          language?: string
          name: string
          parent_id?: string | null
          provider_template_name?: string | null
          status?: string
          tags?: string[] | null
          tenant_id: string
          updated_at?: string
          variables?: Json | null
          version?: number
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          body?: string
          channel_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_draft?: boolean
          kind?: string
          language?: string
          name?: string
          parent_id?: string | null
          provider_template_name?: string | null
          status?: string
          tags?: string[] | null
          tenant_id?: string
          updated_at?: string
          variables?: Json | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "messaging_templates_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_templates_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_templates_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "messaging_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      messaging_webhook_events: {
        Row: {
          channel_id: string
          created_at: string
          error: string | null
          event_type: string
          external_event_id: string | null
          id: string
          last_attempt_at: string | null
          lease_expires_at: string | null
          payload: Json
          processed: boolean
          processed_at: string | null
          provider: string | null
          retry_count: number
          status: string
          tenant_id: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          error?: string | null
          event_type: string
          external_event_id?: string | null
          id?: string
          last_attempt_at?: string | null
          lease_expires_at?: string | null
          payload: Json
          processed?: boolean
          processed_at?: string | null
          provider?: string | null
          retry_count?: number
          status?: string
          tenant_id: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          error?: string | null
          event_type?: string
          external_event_id?: string | null
          id?: string
          last_attempt_at?: string | null
          lease_expires_at?: string | null
          payload?: Json
          processed?: boolean
          processed_at?: string | null
          provider?: string | null
          retry_count?: number
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messaging_webhook_events_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_webhook_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      niche_templates: {
        Row: {
          base_prompt: string
          created_at: string
          description: string | null
          name: string
          plugins: Json
          qualification_dimensions: Json
          slug: string
          stage_prompts: Json
          stages: Json
          updated_at: string
        }
        Insert: {
          base_prompt?: string
          created_at?: string
          description?: string | null
          name: string
          plugins?: Json
          qualification_dimensions?: Json
          slug: string
          stage_prompts?: Json
          stages?: Json
          updated_at?: string
        }
        Update: {
          base_prompt?: string
          created_at?: string
          description?: string | null
          name?: string
          plugins?: Json
          qualification_dimensions?: Json
          slug?: string
          stage_prompts?: Json
          stages?: Json
          updated_at?: string
        }
        Relationships: []
      }
      nurture_enrollments: {
        Row: {
          attempts: number
          completed_at: string | null
          contact_id: string
          current_step: number
          deal_id: string | null
          enrolled_at: string
          id: string
          next_send_at: string | null
          sequence_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          contact_id: string
          current_step?: number
          deal_id?: string | null
          enrolled_at?: string
          id?: string
          next_send_at?: string | null
          sequence_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          contact_id?: string
          current_step?: number
          deal_id?: string | null
          enrolled_at?: string
          id?: string
          next_send_at?: string | null
          sequence_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nurture_enrollments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nurture_enrollments_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "nurture_enrollments_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nurture_enrollments_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "nurture_sequences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nurture_enrollments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      nurture_execution_history: {
        Row: {
          detail: string | null
          enrollment_id: string
          executed_at: string
          id: string
          outcome: string
          step_number: number
          tenant_id: string
        }
        Insert: {
          detail?: string | null
          enrollment_id: string
          executed_at?: string
          id?: string
          outcome: string
          step_number: number
          tenant_id: string
        }
        Update: {
          detail?: string | null
          enrollment_id?: string
          executed_at?: string
          id?: string
          outcome?: string
          step_number?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nurture_execution_history_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "nurture_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nurture_execution_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      nurture_sequences: {
        Row: {
          channel_id: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          notify_owner: boolean
          periodic_days: number | null
          stagnant_days: number | null
          tenant_id: string
          trigger_stage_id: string | null
          trigger_type: string
          updated_at: string
        }
        Insert: {
          channel_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          notify_owner?: boolean
          periodic_days?: number | null
          stagnant_days?: number | null
          tenant_id: string
          trigger_stage_id?: string | null
          trigger_type?: string
          updated_at?: string
        }
        Update: {
          channel_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notify_owner?: boolean
          periodic_days?: number | null
          stagnant_days?: number | null
          tenant_id?: string
          trigger_stage_id?: string | null
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nurture_sequences_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nurture_sequences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nurture_sequences_trigger_stage_id_fkey"
            columns: ["trigger_stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nurture_sequences_trigger_stage_id_fkey"
            columns: ["trigger_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "nurture_sequences_trigger_stage_id_fkey"
            columns: ["trigger_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
        ]
      }
      nurture_steps: {
        Row: {
          created_at: string
          delay_hours: number
          id: string
          message_template: string
          sequence_id: string
          step_number: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          delay_hours?: number
          id?: string
          message_template: string
          sequence_id: string
          step_number: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          delay_hours?: number
          id?: string
          message_template?: string
          sequence_id?: string
          step_number?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nurture_steps_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "nurture_sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          created_at: string
          description: string
          id: string
          permission_key: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          permission_key: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          permission_key?: string
        }
        Relationships: []
      }
      plan_capabilities: {
        Row: {
          capability_key: string
          created_at: string
          enabled: boolean
          included_quantity: number | null
          metadata: Json
          overage_price_minor: number | null
          plan_id: string
          updated_at: string
        }
        Insert: {
          capability_key: string
          created_at?: string
          enabled?: boolean
          included_quantity?: number | null
          metadata?: Json
          overage_price_minor?: number | null
          plan_id: string
          updated_at?: string
        }
        Update: {
          capability_key?: string
          created_at?: string
          enabled?: boolean
          included_quantity?: number | null
          metadata?: Json
          overage_price_minor?: number | null
          plan_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_capabilities_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "plan_capabilities_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plan_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_catalog: {
        Row: {
          base_price_minor: number
          billing_interval: string
          created_at: string
          currency: string
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          plan_key: string
          updated_at: string
        }
        Insert: {
          base_price_minor?: number
          billing_interval?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          plan_key: string
          updated_at?: string
        }
        Update: {
          base_price_minor?: number
          billing_interval?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          plan_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          appearance: Json
          created_at: string
          disabled: boolean
          email: string | null
          id: string
          name: string
          role: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          appearance?: Json
          created_at?: string
          disabled?: boolean
          email?: string | null
          id: string
          name: string
          role: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          appearance?: Json
          created_at?: string
          disabled?: boolean
          email?: string | null
          id?: string
          name?: string
          role?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          identifier: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          identifier: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          identifier?: string
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          created_at: string
          permission_id: string
          role_id: string
        }
        Insert: {
          created_at?: string
          permission_id: string
          role_id: string
        }
        Update: {
          created_at?: string
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          id: string
          is_system: boolean
          name: string
          role_key: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_system?: boolean
          name: string
          role_key: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_system?: boolean
          name?: string
          role_key?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_regions: {
        Row: {
          created_at: string
          external_seller_id: string | null
          id: string
          name: string
          tenant_id: string
          uf: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_seller_id?: string | null
          id?: string
          name: string
          tenant_id: string
          uf: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_seller_id?: string | null
          id?: string
          name?: string
          tenant_id?: string
          uf?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_regions_external_seller_id_fkey"
            columns: ["external_seller_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_regions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      service_route_cities: {
        Row: {
          active: boolean
          city: string
          city_norm: string | null
          created_at: string
          id: string
          region_id: string | null
          tenant_id: string
          uf: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          city: string
          city_norm?: string | null
          created_at?: string
          id?: string
          region_id?: string | null
          tenant_id: string
          uf: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          city?: string
          city_norm?: string | null
          created_at?: string
          id?: string
          region_id?: string | null
          tenant_id?: string
          uf?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_route_cities_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "service_regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_route_cities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stage_ai_config: {
        Row: {
          advancement_criteria: Json
          created_at: string
          enabled: boolean
          entry_criteria: Json
          handoff_keywords: string[]
          id: string
          stage_goal: string | null
          stage_id: string
          system_prompt: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          advancement_criteria?: Json
          created_at?: string
          enabled?: boolean
          entry_criteria?: Json
          handoff_keywords?: string[]
          id?: string
          stage_goal?: string | null
          stage_id: string
          system_prompt?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          advancement_criteria?: Json
          created_at?: string
          enabled?: boolean
          entry_criteria?: Json
          handoff_keywords?: string[]
          id?: string
          stage_goal?: string | null
          stage_id?: string
          system_prompt?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stage_ai_config_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_ai_config_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "stage_ai_config_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "stage_ai_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stage_transitions: {
        Row: {
          ai_priority: number
          autonomy_mode: string
          board_id: string
          cooldown_minutes: number
          created_at: string
          enabled: boolean
          from_stage_id: string
          id: string
          min_confidence: number
          required_signals: Json
          requires_human_approval: boolean
          tenant_id: string
          to_stage_id: string
          updated_at: string
        }
        Insert: {
          ai_priority?: number
          autonomy_mode?: string
          board_id: string
          cooldown_minutes?: number
          created_at?: string
          enabled?: boolean
          from_stage_id: string
          id?: string
          min_confidence?: number
          required_signals?: Json
          requires_human_approval?: boolean
          tenant_id: string
          to_stage_id: string
          updated_at?: string
        }
        Update: {
          ai_priority?: number
          autonomy_mode?: string
          board_id?: string
          cooldown_minutes?: number
          created_at?: string
          enabled?: boolean
          from_stage_id?: string
          id?: string
          min_confidence?: number
          required_signals?: Json
          requires_human_approval?: boolean
          tenant_id?: string
          to_stage_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stage_transitions_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_transitions_from_stage_id_fkey"
            columns: ["from_stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_transitions_from_stage_id_fkey"
            columns: ["from_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "stage_transitions_from_stage_id_fkey"
            columns: ["from_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "stage_transitions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_transitions_to_stage_id_fkey"
            columns: ["to_stage_id"]
            isOneToOne: false
            referencedRelation: "board_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_transitions_to_stage_id_fkey"
            columns: ["to_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_avg_time"
            referencedColumns: ["stage_id"]
          },
          {
            foreignKeyName: "stage_transitions_to_stage_id_fkey"
            columns: ["to_stage_id"]
            isOneToOne: false
            referencedRelation: "v_stef_stage_conversion"
            referencedColumns: ["stage_id"]
          },
        ]
      }
      subscription_items: {
        Row: {
          capability_key: string
          created_at: string
          enabled: boolean
          id: string
          metadata: Json
          quantity: number | null
          subscription_id: string
          unit_price_minor: number | null
          updated_at: string
        }
        Insert: {
          capability_key: string
          created_at?: string
          enabled?: boolean
          id?: string
          metadata?: Json
          quantity?: number | null
          subscription_id: string
          unit_price_minor?: number | null
          updated_at?: string
        }
        Update: {
          capability_key?: string
          created_at?: string
          enabled?: boolean
          id?: string
          metadata?: Json
          quantity?: number | null
          subscription_id?: string
          unit_price_minor?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_items_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "subscription_items_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          external_provider: string | null
          external_subscription_id: string | null
          grace_until: string | null
          id: string
          metadata: Json
          plan_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          external_provider?: string | null
          external_subscription_id?: string | null
          grace_until?: string | null
          id?: string
          metadata?: Json
          plan_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          external_provider?: string | null
          external_subscription_id?: string | null
          grace_until?: string | null
          id?: string
          metadata?: Json
          plan_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plan_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      system_events: {
        Row: {
          context: Json
          conversation_id: string | null
          correlation_id: string | null
          deal_id: string | null
          error_code: string | null
          id: string
          message: string
          operation: string
          severity: string
          source: string
          stack: string | null
          tenant_id: string | null
          ts: string
        }
        Insert: {
          context?: Json
          conversation_id?: string | null
          correlation_id?: string | null
          deal_id?: string | null
          error_code?: string | null
          id?: string
          message: string
          operation: string
          severity: string
          source: string
          stack?: string | null
          tenant_id?: string | null
          ts?: string
        }
        Update: {
          context?: Json
          conversation_id?: string | null
          correlation_id?: string | null
          deal_id?: string | null
          error_code?: string | null
          id?: string
          message?: string
          operation?: string
          severity?: string
          source?: string
          stack?: string | null
          tenant_id?: string | null
          ts?: string
        }
        Relationships: []
      }
      tags: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      template_schedule_executions: {
        Row: {
          applied_variables: Json
          attempt_count: number
          contact_id: string
          error_message: string | null
          external_id: string | null
          id: string
          last_attempt_at: string | null
          message_kind: string | null
          provider_slug: string | null
          schedule_id: string
          scheduled_for: string
          sent_at: string | null
          status: string
        }
        Insert: {
          applied_variables?: Json
          attempt_count?: number
          contact_id: string
          error_message?: string | null
          external_id?: string | null
          id?: string
          last_attempt_at?: string | null
          message_kind?: string | null
          provider_slug?: string | null
          schedule_id: string
          scheduled_for: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          applied_variables?: Json
          attempt_count?: number
          contact_id?: string
          error_message?: string | null
          external_id?: string | null
          id?: string
          last_attempt_at?: string | null
          message_kind?: string | null
          provider_slug?: string | null
          schedule_id?: string
          scheduled_for?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "template_schedule_executions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_schedule_executions_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "template_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      template_schedules: {
        Row: {
          audience_filter: Json
          channel_id: string | null
          created_at: string
          failed_count: number
          id: string
          name: string | null
          scheduled_for: string
          sent_count: number
          status: string
          template_id: string
          tenant_id: string
        }
        Insert: {
          audience_filter?: Json
          channel_id?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          name?: string | null
          scheduled_for: string
          sent_count?: number
          status?: string
          template_id: string
          tenant_id: string
        }
        Update: {
          audience_filter?: Json
          channel_id?: string | null
          created_at?: string
          failed_count?: number
          id?: string
          name?: string | null
          scheduled_for?: string
          sent_count?: number
          status?: string
          template_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "template_schedules_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_schedules_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "messaging_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_schedules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_ai_features: {
        Row: {
          config: Json
          enabled: boolean
          enabled_at: string | null
          feature_key: string
          id: string
          prompt_override: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          config?: Json
          enabled?: boolean
          enabled_at?: string | null
          feature_key: string
          id?: string
          prompt_override?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          config?: Json
          enabled?: boolean
          enabled_at?: string | null
          feature_key?: string
          id?: string
          prompt_override?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ai_features_feature_key_fkey"
            columns: ["feature_key"]
            isOneToOne: false
            referencedRelation: "ai_feature_catalog"
            referencedColumns: ["feature_key"]
          },
          {
            foreignKeyName: "tenant_ai_features_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_ai_features_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_capability_quotas: {
        Row: {
          capability_key: string
          created_at: string
          enforcement_mode: string
          hard_limit: number
          meter_key: string
          period: string
          source: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          capability_key: string
          created_at?: string
          enforcement_mode?: string
          hard_limit: number
          meter_key: string
          period?: string
          source?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          capability_key?: string
          created_at?: string
          enforcement_mode?: string
          hard_limit?: number
          meter_key?: string
          period?: string
          source?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_capability_quotas_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "tenant_capability_quotas_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_commercial_settings: {
        Row: {
          created_at: string
          external_seller_rs_profile_id: string | null
          finance_profile_id: string | null
          sales_manager_profile_id: string | null
          televendas_rs_profile_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_seller_rs_profile_id?: string | null
          finance_profile_id?: string | null
          sales_manager_profile_id?: string | null
          televendas_rs_profile_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_seller_rs_profile_id?: string | null
          finance_profile_id?: string | null
          sales_manager_profile_id?: string | null
          televendas_rs_profile_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_commercial_settings_external_seller_rs_profile_id_fkey"
            columns: ["external_seller_rs_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_commercial_settings_finance_profile_id_fkey"
            columns: ["finance_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_commercial_settings_sales_manager_profile_id_fkey"
            columns: ["sales_manager_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_commercial_settings_televendas_rs_profile_id_fkey"
            columns: ["televendas_rs_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_commercial_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_entitlements: {
        Row: {
          capability_key: string
          created_at: string
          enabled: boolean
          expires_at: string | null
          granted_by: string | null
          id: string
          metadata: Json
          source: string
          starts_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          capability_key: string
          created_at?: string
          enabled?: boolean
          expires_at?: string | null
          granted_by?: string | null
          id?: string
          metadata?: Json
          source?: string
          starts_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          capability_key?: string
          created_at?: string
          enabled?: boolean
          expires_at?: string | null
          granted_by?: string | null
          id?: string
          metadata?: Json
          source?: string
          starts_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_entitlements_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "tenant_entitlements_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_entitlements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_integrations: {
        Row: {
          config: Json
          connected_at: string | null
          created_at: string
          last_check_at: string | null
          last_error: string | null
          slug: string
          status: string
          tenant_id: string
          updated_at: string
          webhook_token: string | null
        }
        Insert: {
          config?: Json
          connected_at?: string | null
          created_at?: string
          last_check_at?: string | null
          last_error?: string | null
          slug: string
          status?: string
          tenant_id: string
          updated_at?: string
          webhook_token?: string | null
        }
        Update: {
          config?: Json
          connected_at?: string | null
          created_at?: string
          last_check_at?: string | null
          last_error?: string | null
          slug?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          webhook_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_integrations_slug_fkey"
            columns: ["slug"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "tenant_integrations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_marketplace_installations: {
        Row: {
          configuration: Json
          created_at: string
          desired_enabled: boolean
          engine_id: string
          health_checked_at: string | null
          health_message: string | null
          health_status: string
          id: string
          installed_at: string | null
          installed_version: string
          lifecycle_status: string
          tenant_id: string
          uninstalled_at: string | null
          updated_at: string
        }
        Insert: {
          configuration?: Json
          created_at?: string
          desired_enabled?: boolean
          engine_id: string
          health_checked_at?: string | null
          health_message?: string | null
          health_status?: string
          id?: string
          installed_at?: string | null
          installed_version: string
          lifecycle_status?: string
          tenant_id: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Update: {
          configuration?: Json
          created_at?: string
          desired_enabled?: boolean
          engine_id?: string
          health_checked_at?: string | null
          health_message?: string | null
          health_status?: string
          id?: string
          installed_at?: string | null
          installed_version?: string
          lifecycle_status?: string
          tenant_id?: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_marketplace_installations_engine_id_fkey"
            columns: ["engine_id"]
            isOneToOne: false
            referencedRelation: "marketplace_engine_catalog"
            referencedColumns: ["engine_id"]
          },
          {
            foreignKeyName: "tenant_marketplace_installations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_memberships: {
        Row: {
          created_at: string
          id: string
          joined_at: string
          revoked_at: string | null
          role_id: string
          status: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          joined_at?: string
          revoked_at?: string | null
          role_id: string
          status?: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          joined_at?: string
          revoked_at?: string | null
          role_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_memberships_role_id_tenant_id_fkey"
            columns: ["role_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "tenant_memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_plugin_installations: {
        Row: {
          capability_key: string
          configuration: Json
          created_at: string
          desired_enabled: boolean
          health_checked_at: string | null
          health_message: string | null
          health_status: string
          id: string
          installed_at: string | null
          plugin_key: string
          provisioning_status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          capability_key: string
          configuration?: Json
          created_at?: string
          desired_enabled?: boolean
          health_checked_at?: string | null
          health_message?: string | null
          health_status?: string
          id?: string
          installed_at?: string | null
          plugin_key: string
          provisioning_status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          capability_key?: string
          configuration?: Json
          created_at?: string
          desired_enabled?: boolean
          health_checked_at?: string | null
          health_message?: string | null
          health_status?: string
          id?: string
          installed_at?: string | null
          plugin_key?: string
          provisioning_status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_plugin_installations_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "tenant_plugin_installations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_view_preferences: {
        Row: {
          prefs: Json
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          prefs?: Json
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          prefs?: Json
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_view_preferences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          ai_enabled: boolean
          business_profile: Json
          created_at: string
          id: string
          logo_url: string | null
          name: string
          niche: string | null
          onboarded_at: string | null
          updated_at: string
        }
        Insert: {
          ai_enabled?: boolean
          business_profile?: Json
          created_at?: string
          id?: string
          logo_url?: string | null
          name: string
          niche?: string | null
          onboarded_at?: string | null
          updated_at?: string
        }
        Update: {
          ai_enabled?: boolean
          business_profile?: Json
          created_at?: string
          id?: string
          logo_url?: string | null
          name?: string
          niche?: string | null
          onboarded_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      uf_routing_rules: {
        Row: {
          created_at: string
          id: string
          owner_id: string
          tenant_id: string
          uf: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          owner_id: string
          tenant_id: string
          uf: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          owner_id?: string
          tenant_id?: string
          uf?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "uf_routing_rules_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "uf_routing_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_aggregates: {
        Row: {
          capability_key: string
          event_count: number
          meter_key: string
          period_end: string
          period_start: string
          quantity: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          capability_key: string
          event_count?: number
          meter_key: string
          period_end: string
          period_start: string
          quantity?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          capability_key?: string
          event_count?: number
          meter_key?: string
          period_end?: string
          period_start?: string
          quantity?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_aggregates_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "usage_aggregates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_events: {
        Row: {
          capability_key: string
          created_at: string
          dimensions: Json
          id: string
          idempotency_key: string
          meter_key: string
          occurred_at: string
          quantity: number
          source: string
          tenant_id: string
        }
        Insert: {
          capability_key: string
          created_at?: string
          dimensions?: Json
          id?: string
          idempotency_key: string
          meter_key: string
          occurred_at?: string
          quantity?: number
          source?: string
          tenant_id: string
        }
        Update: {
          capability_key?: string
          created_at?: string
          dimensions?: Json
          id?: string
          idempotency_key?: string
          meter_key?: string
          occurred_at?: string
          quantity?: number
          source?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "capability_catalog"
            referencedColumns: ["capability_key"]
          },
          {
            foreignKeyName: "usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_call_events: {
        Row: {
          applied: boolean
          call_id: string
          event_id: string
          event_type: string
          id: string
          occurred_at: string
          payload: Json
          received_at: string
          sequence: number | null
          tenant_id: string
        }
        Insert: {
          applied: boolean
          call_id: string
          event_id: string
          event_type: string
          id?: string
          occurred_at: string
          payload?: Json
          received_at?: string
          sequence?: number | null
          tenant_id: string
        }
        Update: {
          applied?: boolean
          call_id?: string
          event_id?: string
          event_type?: string
          id?: string
          occurred_at?: string
          payload?: Json
          received_at?: string
          sequence?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_call_events_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "voice_calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_call_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_calls: {
        Row: {
          agent_ref: string
          answered_at: string | null
          contact_id: string
          created_at: string
          deal_id: string | null
          direction: string
          duration_seconds: number | null
          ended_at: string | null
          error_code: string | null
          error_message: string | null
          id: string
          idempotency_key: string
          is_simulation: boolean
          last_event_at: string | null
          metadata: Json
          objective: string
          outcome: string | null
          phone: string
          provider: string | null
          provider_call_id: string | null
          recording_ref: string | null
          requested_by: string | null
          schedule_id: string | null
          started_at: string | null
          status: string
          summary: string | null
          summary_seq: number | null
          tenant_id: string
          transcript: string | null
          transcript_seq: number | null
          updated_at: string
        }
        Insert: {
          agent_ref?: string
          answered_at?: string | null
          contact_id: string
          created_at?: string
          deal_id?: string | null
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key: string
          is_simulation?: boolean
          last_event_at?: string | null
          metadata?: Json
          objective: string
          outcome?: string | null
          phone: string
          provider?: string | null
          provider_call_id?: string | null
          recording_ref?: string | null
          requested_by?: string | null
          schedule_id?: string | null
          started_at?: string | null
          status?: string
          summary?: string | null
          summary_seq?: number | null
          tenant_id: string
          transcript?: string | null
          transcript_seq?: number | null
          updated_at?: string
        }
        Update: {
          agent_ref?: string
          answered_at?: string | null
          contact_id?: string
          created_at?: string
          deal_id?: string | null
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string
          is_simulation?: boolean
          last_event_at?: string | null
          metadata?: Json
          objective?: string
          outcome?: string | null
          phone?: string
          provider?: string | null
          provider_call_id?: string | null
          recording_ref?: string | null
          requested_by?: string | null
          schedule_id?: string | null
          started_at?: string | null
          status?: string
          summary?: string | null
          summary_seq?: number | null
          tenant_id?: string
          transcript?: string | null
          transcript_seq?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_calls_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_calls_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deal_sla_status"
            referencedColumns: ["deal_id"]
          },
          {
            foreignKeyName: "voice_calls_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_calls_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_calls_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "template_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_calls_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          attempts: number
          available_at: string
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          event_id: string
          event_type: string
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          response_excerpt: string | null
          response_status: number | null
          status: string
          tenant_id: string
        }
        Insert: {
          attempts?: number
          available_at?: string
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          event_id: string
          event_type: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          response_excerpt?: string | null
          response_status?: number | null
          status?: string
          tenant_id: string
        }
        Update: {
          attempts?: number
          available_at?: string
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          event_id?: string
          event_type?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          response_excerpt?: string | null
          response_status?: number | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_endpoint_id_tenant_id_fkey"
            columns: ["endpoint_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "webhook_endpoints"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "webhook_deliveries_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "domain_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_endpoints: {
        Row: {
          active: boolean
          board_ids: string[]
          created_at: string
          created_by: string | null
          description: string | null
          disabled_reason: string | null
          event_types: string[]
          id: string
          previous_secret_expires_at: string | null
          previous_vault_secret_id: string | null
          stage_ids: string[]
          tenant_id: string
          updated_at: string
          url: string
          vault_secret_id: string | null
        }
        Insert: {
          active?: boolean
          board_ids?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          disabled_reason?: string | null
          event_types: string[]
          id?: string
          previous_secret_expires_at?: string | null
          previous_vault_secret_id?: string | null
          stage_ids?: string[]
          tenant_id: string
          updated_at?: string
          url: string
          vault_secret_id?: string | null
        }
        Update: {
          active?: boolean
          board_ids?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          disabled_reason?: string | null
          event_types?: string[]
          id?: string
          previous_secret_expires_at?: string | null
          previous_vault_secret_id?: string | null
          stage_ids?: string[]
          tenant_id?: string
          updated_at?: string
          url?: string
          vault_secret_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_endpoints_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_report_deliveries: {
        Row: {
          address: string
          attempt_count: number
          channel: string
          id: string
          recipient_id: string
          report_id: string
          status: string
          updated_at: string | null
        }
        Insert: {
          address: string
          attempt_count?: number
          channel: string
          id?: string
          recipient_id: string
          report_id: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          address?: string
          attempt_count?: number
          channel?: string
          id?: string
          recipient_id?: string
          report_id?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "weekly_report_deliveries_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "weekly_report_recipients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_report_deliveries_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "weekly_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_report_recipients: {
        Row: {
          active: boolean
          address: string
          channel: string
          id: string
          name: string | null
          tenant_id: string
        }
        Insert: {
          active?: boolean
          address: string
          channel: string
          id?: string
          name?: string | null
          tenant_id: string
        }
        Update: {
          active?: boolean
          address?: string
          channel?: string
          id?: string
          name?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_report_recipients_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_reports: {
        Row: {
          created_at: string | null
          id: string
          metrics: Json
          period_end: string
          period_start: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          metrics: Json
          period_end: string
          period_start: string
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          metrics?: Json
          period_end?: string
          period_start?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_reports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      deal_owner_leaderboard: {
        Row: {
          decided: number | null
          owner_id: string | null
          owner_name: string | null
          tenant_id: string | null
          total_won_value: number | null
          win_rate_pct: number | null
          wins: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_sla_status: {
        Row: {
          board_key: string | null
          contact_attempts: number | null
          deal_id: string | null
          is_overdue: boolean | null
          max_attempts: number | null
          owner_id: string | null
          stage_due_at: string | null
          stage_entered_at: string | null
          stage_key: string | null
          stage_name: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_event_delivery_health: {
        Row: {
          delivery_count: number | null
          latest_update_at: string | null
          oldest_created_at: string | null
          status: string | null
          subscriber_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_deliveries_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "domain_event_subscriptions"
            referencedColumns: ["subscriber_id"]
          },
        ]
      }
      v_stef_activation_rate: {
        Row: {
          activated: number | null
          activation_pct: number | null
          eligible: number | null
          first_orders: number | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_clients_by_origin: {
        Row: {
          client_origin:
            | Database["public"]["Enums"]["client_origin_type"]
            | null
          clients: number | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_cost_per_client: {
        Row: {
          clients: number | null
          cost_per_client: number | null
          month: string | null
          spend: number | null
          tenant_id: string | null
        }
        Relationships: []
      }
      v_stef_first_order: {
        Row: {
          avg_ticket: number | null
          month: string | null
          orders: number | null
          tenant_id: string | null
          total: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_first_order_mix: {
        Row: {
          orders: number | null
          product: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_lead_to_client: {
        Row: {
          clients: number | null
          conversion_pct: number | null
          leads: number | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_leads_by_origin: {
        Row: {
          lead_origin: Database["public"]["Enums"]["lead_origin_type"] | null
          leads: number | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_leads_by_owner: {
        Row: {
          leads: number | null
          owner_id: string | null
          owner_name: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_out_of_area_demand: {
        Row: {
          city: string | null
          group_level: string | null
          kg_month: number | null
          leads: number | null
          region_name: string | null
          tenant_id: string | null
          uf: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_overdue_summary: {
        Row: {
          board_key: string | null
          overdue: number | null
          owner_id: string | null
          stage_key: string | null
          stage_name: string | null
          tenant_id: string | null
          total: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stef_stage_avg_time: {
        Row: {
          avg_hours: number | null
          board_id: string | null
          name: string | null
          passages: number | null
          stage_id: string | null
          stage_key: string | null
          tenant_id: string | null
        }
        Relationships: []
      }
      v_stef_stage_conversion: {
        Row: {
          board_id: string | null
          conversion_pct: number | null
          deals_next: number | null
          deals_reached: number | null
          name: string | null
          position: number | null
          stage_id: string | null
          stage_key: string | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "board_stages_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boards_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      ack_event_delivery: {
        Args: { p_delivery_id: string; p_worker_id: string }
        Returns: boolean
      }
      activate_scheduled_jobs: { Args: never; Returns: Json }
      add_manual_phone_suppression: {
        Args: { p_phone: string; p_reason: string }
        Returns: {
          contact_id: string | null
          id: string
          metadata: Json
          phone: string
          reactivated_at: string | null
          reason: string
          scope: string
          source: string
          suppressed_at: string
          tenant_id: string
        }
        SetofOptions: {
          from: "*"
          to: "messaging_phone_suppressions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      api_allowed_scopes: { Args: never; Returns: string[] }
      apply_niche_template: {
        Args: {
          p_base_prompt: string
          p_board_id: string
          p_niche_slug: string
          p_stage_prompts: Json
          p_stages: Json
        }
        Returns: Json
      }
      apply_voice_call_event: { Args: { p_event: Json }; Returns: Json }
      approve_template_version: {
        Args: { p_template_id: string }
        Returns: Json
      }
      authenticate_api_key: {
        Args: { p_key_hash: string }
        Returns: {
          key_id: string
          scopes: string[]
          tenant_id: string
        }[]
      }
      bootstrap_status: { Args: never; Returns: Json }
      bump_channel_webhook_failure: {
        Args: { p_channel_id: string }
        Returns: number
      }
      campaign_execution_stats: {
        Args: { p_schedule_ids: string[] }
        Returns: {
          schedule_id: string
          status: string
          total: number
        }[]
      }
      check_and_record_rate_limit: {
        Args: { p_key: string; p_max_calls: number; p_window_seconds: number }
        Returns: Json
      }
      claim_ai_processing_message: {
        Args: {
          p_conversation_id: string
          p_lease_seconds?: number
          p_message_id: string
          p_tenant_id: string
        }
        Returns: {
          attempt: number
          claim_state: string
          claimed: boolean
          lease_expires_at: string
          lease_token: string
        }[]
      }
      claim_billing_webhook_event: {
        Args: {
          p_event_type: string
          p_external_event_id: string
          p_payload: Json
          p_provider: string
        }
        Returns: Json
      }
      claim_contact_enrichment: { Args: never; Returns: Json }
      claim_event_deliveries: {
        Args: {
          p_event_types?: string[]
          p_lease_seconds?: number
          p_limit?: number
          p_subscriber_ids?: string[]
          p_worker_id: string
        }
        Returns: {
          aggregate_id: string
          aggregate_type: string
          attempts: number
          delivery_id: string
          event_id: string
          event_type: string
          max_attempts: number
          metadata: Json
          occurred_at: string
          payload: Json
          schema_version: number
          subscriber_id: string
          tenant_id: string
        }[]
      }
      claim_jobs: {
        Args: { p_job_types?: string[]; p_limit?: number }
        Returns: {
          attempts: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          job_type: string
          max_attempts: number
          payload: Json
          scheduled_for: string
          started_at: string | null
          status: string
          tenant_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_messaging_webhook_event: {
        Args: {
          p_channel_id: string
          p_event_type: string
          p_external_event_id: string
          p_payload: Json
          p_tenant_id: string
        }
        Returns: {
          attempt: number
          claim_state: string
          event_id: string
        }[]
      }
      claim_webhook_deliveries: {
        Args: { p_limit: number; p_worker: string }
        Returns: {
          attempts: number
          available_at: string
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          event_id: string
          event_type: string
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          response_excerpt: string | null
          response_status: number | null
          status: string
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "webhook_deliveries"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_contact_enrichment: {
        Args: {
          p_contact_id: string
          p_lease_token: string
          p_model: string
          p_result: Json
        }
        Returns: Json
      }
      complete_webhook_delivery: {
        Args: {
          p_delivery_id: string
          p_response_excerpt?: string
          p_response_status: number
          p_worker: string
        }
        Returns: undefined
      }
      configure_internal_access: {
        Args: { p_project_url: string; p_service_role_key: string }
        Returns: Json
      }
      configure_marketplace_engine: {
        Args: {
          p_configuration: Json
          p_engine_id: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      consume_capability_usage: {
        Args: {
          p_capability_key: string
          p_dimensions?: Json
          p_idempotency_key: string
          p_meter_key: string
          p_occurred_at?: string
          p_quantity?: number
          p_tenant_id: string
        }
        Returns: Json
      }
      create_api_key: {
        Args: { p_expires_at?: string; p_name: string; p_scopes: string[] }
        Returns: {
          id: string
          token: string
        }[]
      }
      create_inbound_rule: {
        Args: {
          p_action: string
          p_action_config: Json
          p_allowed_stage_ids: string[]
          p_board_id: string
          p_conditions: Json
          p_custom_field_key: string
          p_event_id_path: string
          p_match_field: string
          p_match_path: string
          p_name: string
          p_not_found_mode: string
          p_secret: string
          p_token_header_name: string
          p_verification_mode: string
        }
        Returns: {
          id: string
          secret: string
        }[]
      }
      create_simulator_channel: { Args: never; Returns: string }
      create_template_draft: {
        Args: {
          p_body: string
          p_kind?: string
          p_language?: string
          p_name: string
          p_parent_id: string
          p_provider_template_name?: string
          p_tags?: string[]
          p_variables?: Json
        }
        Returns: Json
      }
      create_webhook_endpoint:
        | {
            Args: {
              p_description?: string
              p_event_types: string[]
              p_url: string
            }
            Returns: {
              id: string
              secret: string
            }[]
          }
        | {
            Args: {
              p_board_ids: string[]
              p_description: string
              p_event_types: string[]
              p_stage_ids: string[]
              p_url: string
            }
            Returns: {
              id: string
              secret: string
            }[]
          }
      dashboard_ai_hitl_performance: {
        Args: {
          p_board_id?: string
          p_from: string
          p_owner_id?: string
          p_to: string
        }
        Returns: Json
      }
      dashboard_messaging_performance: {
        Args: { p_from: string; p_owner_id?: string; p_to: string }
        Returns: Json
      }
      dashboard_report: {
        Args: { p_from: string; p_to: string; p_tz?: string }
        Returns: Json
      }
      dashboard_report_for_tenant: {
        Args: {
          p_from: string
          p_tenant_id: string
          p_to: string
          p_tz?: string
        }
        Returns: Json
      }
      dashboard_wallet_health: {
        Args: {
          p_inactive_days?: number
          p_owner_id?: string
          p_stagnant_days?: number
        }
        Returns: Json
      }
      delete_inbound_rule: { Args: { p_id: string }; Returns: undefined }
      delete_webhook_endpoint: { Args: { p_id: string }; Returns: undefined }
      e2e_reset_onboarding: { Args: never; Returns: undefined }
      enqueue_ai_response_job: {
        Args: { p_message_id: string; p_tenant_id: string }
        Returns: {
          job_id: string
          should_dispatch: boolean
        }[]
      }
      enqueue_contact_enrichment: {
        Args: { p_event_id: string }
        Returns: boolean
      }
      enroll_manual_nurture_sequence: {
        Args: { p_appointment_at: string; p_contact_id: string }
        Returns: boolean
      }
      enroll_stagnant_and_periodic_nurture: { Args: never; Returns: Json }
      estimate_campaign_audience: { Args: { p_filter: Json }; Returns: number }
      evaluate_capability: {
        Args: { p_capability_key: string; p_operation?: string }
        Returns: Json
      }
      expire_old_pending_advances: { Args: never; Returns: Json }
      fail_event_delivery: {
        Args: {
          p_delivery_id: string
          p_error: string
          p_retry_delay_seconds?: number
          p_worker_id: string
        }
        Returns: string
      }
      fail_webhook_delivery: {
        Args: {
          p_delivery_id: string
          p_error: string
          p_response_excerpt?: string
          p_response_status?: number
          p_retry_at?: string
          p_worker: string
        }
        Returns: undefined
      }
      feegow_upsert_appointments: { Args: { p_rows: Json }; Returns: number }
      find_duplicate_contacts: { Args: never; Returns: Json }
      finish_ai_processing_message: {
        Args: {
          p_error?: string
          p_lease_token: string
          p_message_id: string
          p_status: string
        }
        Returns: boolean
      }
      get_channel_qr_codes: {
        Args: never
        Returns: {
          channel_id: string
          expires_at: string
          qr_code: string
        }[]
      }
      get_channel_webhook_tokens: {
        Args: never
        Returns: {
          channel_id: string
          webhook_token: string
        }[]
      }
      get_edge_function_error_alerts: {
        Args: never
        Returns: {
          errors_15m: number
          errors_prev_15m: number
          function_name: string
          last_at: string
          last_error_code: string
          last_message: string
          operation: string
          severity: string
          spike: boolean
        }[]
      }
      get_inbound_rule_auth: {
        Args: { p_rule_id: string }
        Returns: {
          active: boolean
          current_secret: string
          previous_secret: string
          tenant_id: string
          token_header_name: string
          verification_mode: string
        }[]
      }
      get_incident_alerts: {
        Args: never
        Returns: {
          code: string
          kind: string
          last_at: string
          occurrences: number
          scope: string
          severity: string
        }[]
      }
      get_integration_health_alerts: {
        Args: never
        Returns: {
          failures_15m: number
          human_message: string
          last_check_at: string
          last_error: string
          reason_code: string
          severity: string
          slug: string
        }[]
      }
      get_my_capabilities: {
        Args: never
        Returns: {
          capability_key: string
          enabled: boolean
          source: string
        }[]
      }
      get_my_permissions: { Args: never; Returns: string[] }
      get_pipeline_automation_metrics: {
        Args: { p_board_id: string; p_since?: string }
        Returns: Json
      }
      get_public_lead_form: {
        Args: { p_form_id: string }
        Returns: {
          fields: Json
          id: string
          name: string
          success_message: string
        }[]
      }
      get_tenant_team: {
        Args: never
        Returns: {
          disabled: boolean
          email: string
          id: string
          name: string
          role: string
        }[]
      }
      get_webhook_secrets: {
        Args: { p_endpoint_id: string }
        Returns: {
          current: string
          previous: string
        }[]
      }
      has_capability: { Args: { p_capability_key: string }; Returns: boolean }
      inbound_rule_stats: {
        Args: { p_rule_id: string }
        Returns: {
          status: string
          total: number
        }[]
      }
      inbound_rule_stats_tenant: {
        Args: never
        Returns: {
          rule_id: string
          status: string
          total: number
        }[]
      }
      install_marketplace_engine: {
        Args: {
          p_configuration?: Json
          p_engine_id: string
          p_tenant_id: string
        }
        Returns: number
      }
      invoke_ai_response_worker: { Args: never; Returns: number }
      invoke_domain_event_dispatcher: { Args: never; Returns: number }
      kb_search_for_tenant: {
        Args: {
          p_match_count?: number
          p_min_similarity?: number
          p_query_embedding: string
          p_tenant_id: string
        }
        Returns: {
          chunk_index: number
          content: string
          document_id: string
          document_title: string
          similarity: number
        }[]
      }
      list_my_workspaces: {
        Args: never
        Returns: {
          is_active: boolean
          logo_url: string
          role_key: string
          tenant_id: string
          tenant_name: string
        }[]
      }
      log_client_error: {
        Args: {
          p_context?: Json
          p_correlation_id?: string
          p_error_code?: string
          p_message: string
          p_route: string
          p_stack?: string
        }
        Returns: undefined
      }
      manage_tenant_membership: {
        Args: { p_membership_id: string; p_role_id?: string; p_status?: string }
        Returns: {
          created_at: string
          id: string
          joined_at: string
          revoked_at: string | null
          role_id: string
          status: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "tenant_memberships"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mark_out_of_area: {
        Args: { p_deal_id: string; p_note?: string }
        Returns: undefined
      }
      merge_contacts: {
        Args: { p_source_id: string; p_target_id: string }
        Returns: Json
      }
      pause_scheduled_jobs: { Args: never; Returns: Json }
      preview_inbound_rule: {
        Args: { p_rule_id: string; p_sample: Json }
        Returns: Json
      }
      process_inbound_event: {
        Args: { p_payload: Json; p_rule_id: string }
        Returns: Json
      }
      process_nurture_returns: { Args: never; Returns: number }
      prune_domain_events: {
        Args: { p_before: string; p_limit?: number }
        Returns: number
      }
      prune_inbound_events: {
        Args: { p_before: string; p_limit: number }
        Returns: number
      }
      prune_old_channel_status_events: { Args: never; Returns: undefined }
      prune_old_system_events: { Args: never; Returns: number }
      publish_pipeline_signal_event: {
        Args: {
          p_contact_id: string
          p_deal_id: string
          p_event_type: string
          p_idempotency_key: string
          p_payload: Json
        }
        Returns: string
      }
      rate_limit_cleanup: { Args: never; Returns: number }
      reactivate_phone_suppression: {
        Args: { p_suppression_id: string }
        Returns: {
          contact_id: string | null
          id: string
          metadata: Json
          phone: string
          reactivated_at: string | null
          reason: string
          scope: string
          source: string
          suppressed_at: string
          tenant_id: string
        }
        SetofOptions: {
          from: "*"
          to: "messaging_phone_suppressions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reactivate_region: {
        Args: { p_cities: string[]; p_new_owner: string; p_region_id: string }
        Returns: number
      }
      reconcile_subscription_runtime: {
        Args: { p_subscription_id: string }
        Returns: Json
      }
      record_inbound_ignored: {
        Args: { p_reason: string; p_rule_id: string }
        Returns: undefined
      }
      record_usage_event: {
        Args: {
          p_capability_key: string
          p_dimensions?: Json
          p_idempotency_key: string
          p_meter_key: string
          p_occurred_at?: string
          p_quantity?: number
          p_source?: string
          p_tenant_id: string
        }
        Returns: Json
      }
      redeliver_webhook: { Args: { p_delivery_id: string }; Returns: undefined }
      refresh_usage_aggregates: {
        Args: {
          p_period_end: string
          p_period_start: string
          p_tenant_id: string
        }
        Returns: number
      }
      replace_kb_chunks: {
        Args: { p_chunks: Json; p_document_id: string; p_tenant_id: string }
        Returns: number
      }
      replay_event_delivery: {
        Args: { p_available_at?: string; p_delivery_id: string }
        Returns: boolean
      }
      report_marketplace_engine_health: {
        Args: {
          p_engine_id: string
          p_health_status: string
          p_message?: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      request_voice_call: {
        Args: {
          p_agent_ref: string
          p_contact_id: string
          p_deal_id: string
          p_idempotency_key: string
          p_objective: string
        }
        Returns: Json
      }
      request_voice_call_cancel: { Args: { p_call_id: string }; Returns: Json }
      resolve_hitl_decision: {
        Args: {
          p_action: string
          p_decision_id: string
          p_modifications?: Json
          p_reason?: string
          p_snooze_until?: string
        }
        Returns: Json
      }
      resolve_pending_stage_advance: {
        Args: {
          p_action: string
          p_advance_id: string
          p_modifications?: Json
          p_reason?: string
        }
        Returns: Json
      }
      review_deal_stage_evaluation: {
        Args: { p_evaluation_id: string; p_note?: string; p_status: string }
        Returns: Json
      }
      revoke_api_key: { Args: { p_id: string }; Returns: undefined }
      revoke_marketplace_entitlement: {
        Args: {
          p_capability_key: string
          p_reason: string
          p_tenant_id: string
        }
        Returns: number
      }
      rotate_inbound_rule_secret: {
        Args: { p_id: string; p_new_secret: string }
        Returns: string
      }
      rotate_webhook_endpoint_secret: {
        Args: { p_id: string }
        Returns: string
      }
      scheduled_jobs_status: { Args: never; Returns: Json }
      send_test_webhook: { Args: { p_id: string }; Returns: string }
      set_appearance_preference: {
        Args: { p_skin: string; p_theme: string }
        Returns: undefined
      }
      set_inbound_rule_active: {
        Args: { p_active: boolean; p_id: string }
        Returns: undefined
      }
      set_inbound_rule_limits: {
        Args: { p_id: string; p_per_day: number; p_per_minute: number }
        Returns: undefined
      }
      set_marketplace_engine_desired: {
        Args: { p_enabled: boolean; p_engine_id: string; p_tenant_id: string }
        Returns: undefined
      }
      set_nurture_enrollment_status: {
        Args: { p_enrollment_id: string; p_status: string }
        Returns: Json
      }
      set_tenant_plugin_override: {
        Args: { p_active: boolean; p_slug: string }
        Returns: Json
      }
      set_webhook_endpoint_active: {
        Args: { p_active: boolean; p_id: string }
        Returns: undefined
      }
      switch_active_workspace: {
        Args: { p_tenant_id: string }
        Returns: boolean
      }
      sync_contact_identities_for_contact: {
        Args: { p_contact_id: string; p_tenant_id: string }
        Returns: undefined
      }
      sync_subscription_entitlements: {
        Args: { p_subscription_id: string }
        Returns: number
      }
      tem_alguma_conta: { Args: never; Returns: boolean }
      transition_deal_stage: {
        Args: {
          p_actor_id?: string
          p_actor_type?: string
          p_confidence?: number
          p_correlation_id?: string
          p_criteria_evaluation?: Json
          p_deal_id: string
          p_evidence?: Json
          p_expected_stage_id: string
          p_idempotency_key?: string
          p_model_version?: string
          p_prompt_snapshot?: Json
          p_reason?: string
          p_reversal_of_history_id?: string
          p_target_stage_id: string
          p_trigger_event?: string
        }
        Returns: Json
      }
      uninstall_marketplace_engine: {
        Args: { p_engine_id: string; p_tenant_id: string }
        Returns: undefined
      }
      update_inbound_rule: {
        Args: {
          p_action: string
          p_action_config: Json
          p_allowed_stage_ids: string[]
          p_board_id: string
          p_conditions: Json
          p_custom_field_key: string
          p_event_id_path: string
          p_id: string
          p_match_field: string
          p_match_path: string
          p_name: string
          p_not_found_mode: string
          p_token_header_name: string
        }
        Returns: undefined
      }
      update_webhook_endpoint: {
        Args: {
          p_board_ids: string[]
          p_description: string
          p_event_types: string[]
          p_id: string
          p_stage_ids: string[]
          p_url: string
        }
        Returns: undefined
      }
      upsert_cron_vault_secrets: {
        Args: { p_service_key: string; p_url: string }
        Returns: Json
      }
      voice_call_settings: { Args: never; Returns: Json }
      webhook_allowed_event_types: { Args: never; Returns: string[] }
    }
    Enums: {
      client_origin_type: "lead_empresa" | "prospeccao_propria"
      customer_segment_type:
        | "pizzaria"
        | "restaurante"
        | "hamburgueria"
        | "mercado"
        | "padaria"
        | "distribuidor"
        | "outro"
      lead_origin_type:
        | "trafego_pago_site"
        | "whatsapp_instagram"
        | "indicacao_prospeccao"
        | "eventos_chefs"
      lost_reason_code_type:
        | "sem_contato"
        | "preco"
        | "ja_tem_fornecedor"
        | "pedido_minimo"
        | "amostra_nao_aprovada"
        | "credito_reprovado"
        | "sem_perfil"
        | "duplicado_invalido"
      sample_status_type: "pendente" | "aprovada" | "reprovada"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      client_origin_type: ["lead_empresa", "prospeccao_propria"],
      customer_segment_type: [
        "pizzaria",
        "restaurante",
        "hamburgueria",
        "mercado",
        "padaria",
        "distribuidor",
        "outro",
      ],
      lead_origin_type: [
        "trafego_pago_site",
        "whatsapp_instagram",
        "indicacao_prospeccao",
        "eventos_chefs",
      ],
      lost_reason_code_type: [
        "sem_contato",
        "preco",
        "ja_tem_fornecedor",
        "pedido_minimo",
        "amostra_nao_aprovada",
        "credito_reprovado",
        "sem_perfil",
        "duplicado_invalido",
      ],
      sample_status_type: ["pendente", "aprovada", "reprovada"],
    },
  },
} as const
