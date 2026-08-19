import { readFileSync } from 'node:fs';
import path from 'node:path';

const migration = readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20260722090000_read_artwork_palette.sql',
), 'utf8');

describe('read_artwork_palette migration contract', () => {
  it('uses an exact indexed identity and only accepts SHA-256 lookup keys', () => {
    expect(migration).toMatch(
      /create function public\.read_artwork_palette\(\s*p_library_id uuid,\s*p_artwork_key text,\s*p_key_version integer\s*\)/,
    );
    expect(migration).toContain("v_artwork_key !~ '^sha256:[0-9a-f]{64}$'");
    expect(migration).toContain('palette.library_id = p_library_id');
    expect(migration).toContain('palette.artwork_key = v_artwork_key');
    expect(migration).toContain('palette.key_version = p_key_version');
  });

  it('runs behind an empty-search-path security definer boundary', () => {
    expect(migration).toMatch(/security definer\s+set search_path = ''/);
    expect(migration).toMatch(
      /revoke all on function public\.read_artwork_palette\([\s\S]*?\) from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.read_artwork_palette\([\s\S]*?\) to service_role;/,
    );
    expect(migration).not.toMatch(/grant\s+(select|all)\s+on\s+(table\s+)?public\.artwork_palettes/i);
  });

  it('returns only palette and non-sensitive provenance', () => {
    const returnedObject = migration.match(
      /return jsonb_build_object\(([\s\S]*?)\n\s*\);/,
    )?.[1];
    expect(returnedObject).toBeDefined();
    expect(returnedObject).toContain("'palette'");
    expect(returnedObject).toContain("'provider_name'");
    expect(returnedObject).toContain("'updated_at'");
    expect(returnedObject).not.toContain('raw_metadata');
  });
});
