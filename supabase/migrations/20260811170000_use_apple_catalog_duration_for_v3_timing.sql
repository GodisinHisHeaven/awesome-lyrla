-- Apple catalog duration is the source-of-truth for TTML timeline validation.
-- Playback duration remains part of the lookup key and the normalized payload,
-- but can drift far enough to reject otherwise healthy synchronized lyrics.
-- Keep this as a forward-only function replacement so existing v3 leases and
-- projections remain compatible during rollout.
do $migration$
declare
  v_function regprocedure :=
    'public.complete_apple_lyrics_backfill_v3(uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text,text,text)'::regprocedure;
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(v_function)
    into v_definition;

  v_old := E'  v_duration_ms integer;\n  v_job_duration_ms numeric;';
  v_new := E'  v_duration_ms integer;\n  v_job_duration_ms numeric;\n  v_timeline_duration_ms integer;';
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
      / nullif(length(v_old), 0) <> 1 then
    raise exception 'unexpected v3 completion declaration; refusing unsafe replacement'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'  v_repair_method := p_provenance ->> ''timeline_repair_method'';\n\n  if v_validation_version is distinct from';
  v_new := E'  v_repair_method := p_provenance ->> ''timeline_repair_method'';\n  v_timeline_duration_ms := nullif(\n    coalesce(\n      p_provenance ->> ''timeline_duration_ms'',\n      p_provenance ->> ''timelineDurationMs''\n    ),\n    ''''\n  )::integer;\n\n  if v_timeline_duration_ms is not null\n    and (\n      not coalesce(\n        p_provenance -> ''exact_identity_evidence''\n          @> ''["catalog-metadata-duration-independent-v1"]''::jsonb,\n        false\n      )\n      or v_timeline_duration_ms <= 0\n      or v_timeline_duration_ms > 86400000\n    ) then\n    raise exception ''catalog timeline duration requires independent identity evidence''\n      using errcode = ''22023'';\n  end if;\n\n  if v_validation_version is distinct from';
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
      / nullif(length(v_old), 0) <> 1 then
    raise exception 'unexpected v3 completion validation block; refusing unsafe replacement'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'      v_synced_lyrics,\n      v_duration_ms\n    ) is not null then';
  v_new := E'      v_synced_lyrics,\n      coalesce(v_timeline_duration_ms, v_duration_ms)\n    ) is not null then';
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
      / nullif(length(v_old), 0) <> 1 then
    raise exception 'unexpected v3 timing gate; refusing unsafe replacement'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'      - ''timeline_repair_method''\n      - ''timelineRepairMethod''\n  ) || jsonb_build_object(';
  v_new := E'      - ''timeline_repair_method''\n      - ''timelineRepairMethod''\n      - ''timeline_duration_ms''\n      - ''timelineDurationMs''\n  ) || jsonb_build_object(';
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
      / nullif(length(v_old), 0) <> 1 then
    raise exception 'unexpected v3 provenance normalization block; refusing unsafe replacement'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'    ''timeline_repair_method'', v_repair_method\n  );';
  v_new := E'    ''timeline_repair_method'', v_repair_method\n  ) || case\n    when v_timeline_duration_ms is null then ''{}''::jsonb\n    else jsonb_build_object(''timeline_duration_ms'', v_timeline_duration_ms)\n  end;';
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
      / nullif(length(v_old), 0) <> 1 then
    raise exception 'unexpected v3 provenance output block; refusing unsafe replacement'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;
end;
$migration$;
