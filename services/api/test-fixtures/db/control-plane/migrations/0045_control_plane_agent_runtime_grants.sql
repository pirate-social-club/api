DO $$
DECLARE
  agent_table text;
BEGIN
  FOREACH agent_table IN ARRAY ARRAY[
    'user_agents',
    'agent_ownership_records',
    'agent_ownership_sessions',
    'agent_delegated_credentials',
    'agent_action_nonce_replays',
    'agent_pairing_codes',
    'agent_handles'
  ] LOOP
    IF to_regclass(format('public.%I', agent_table)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO control_plane_migrator', agent_table);
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO control_plane_api_rw',
        agent_table
      );
      EXECUTE format(
        'GRANT SELECT ON TABLE public.%I TO control_plane_api_ro, control_plane_ops_ro',
        agent_table
      );
    END IF;
  END LOOP;
END
$$;
