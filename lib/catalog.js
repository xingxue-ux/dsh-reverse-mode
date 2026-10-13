/**
 * Curated REA tool catalog.
 *
 * Why this file exists
 * --------------------
 * REA's MCP server advertises ~170 tools whose combined JSON Schema is roughly
 * 1.9 MB (≈540k tokens). `@deepseek-ai/dsh-mcp-client` registers every tool a
 * server lists into `ctx.tools`, and tool schemas are attached to every model
 * request — so a plain bridge entry for REA would spend more than half a large
 * context window before the conversation starts. REA's own `compact` input
 * schema profile only removes ~9%, which is not enough.
 *
 * Measured cost per tool is spread fairly evenly (roughly 2–45 kB each; the
 * largest are the JS/web/managed entry points), so no handful of tools dominates
 * the total. The lever that works is *count*: this catalog therefore ships the
 * surface as tiers, with only the entry points on by default.
 */

/**
 * Tier 1 — ENTRY (default). One tool per target family, enough to identify a
 * target and learn what it is. ~98 kB of schema (~27k tokens).
 */
export const ENTRY_TOOLS = [
  // Native binaries
  'open_binary',
  'close_binary',
  'binary_overview',

  // JavaScript / Electron applications
  'analyze_javascript_application',

  // Managed (.NET / Java / Go) assemblies
  'inspect_managed_artifact',

  // Archives, installers, mobile bundles, and other packaged artifacts
  'inspect_artifact',

  // Already-running user-owned processes the model may observe
  'list_browser_targets',
  'list_electron_targets',

  // How REA's conclusions stay auditable
  'export_evidence_bundle',
]

/**
 * Tier 2 — NAVIGATE. Reading inside a target once tier 1 identified it.
 * Adds ~93 kB (~26k tokens).
 */
export const NAVIGATE_TOOLS = [
  // Native navigation and code
  'list_procedures',
  'list_strings',
  'list_segments',
  'list_documents',
  'search_procedures',
  'search_strings',
  'procedure_info',
  'procedure_assembly',
  'procedure_pseudo_code',
  'procedure_callers',
  'procedure_callees',
  'xrefs',
  'read_bytes',
  'trace_call_path',

  // Managed and package internals
  'inspect_managed_members',
  'project_managed_application_graph',
  'inspect_macho',
  'inspect_pe_resources',
  'inspect_signature',
  'list_architectures',
  'extract_artifact',
  'inspect_keyed_archive',
  'inspect_plist',
  'inspect_asset_catalog',

  // Android / Apple bundles
  'decode_android_resources',
  'inspect_android_package',
  'search_android_classes',
  'decode_interface_builder',
  'project_apple_application_graph',
  'project_android_application_graph',
]

/**
 * Tier 3 — ANALYZE. Deeper correlation, comparison, and JavaScript/Electron
 * runtime work. Adds ~228 kB (~63k tokens); opt in when a task is really an
 * investigation rather than a question.
 */
export const ANALYZE_TOOLS = [
  // JavaScript and Electron runtime
  'trace_javascript_semantics',
  'compare_javascript_export_shapes',
  'reconcile_javascript_runtime',
  'observe_javascript_runtime',
  'recover_javascript_sources',
  'list_javascript_runtime_targets',
  'inspect_electron_page',

  // Native deep analysis
  'inspect_binary_layout',
  'analyze_function',
  'batch_decompile',
  'binary_session',
  'get_evidence_bundle',

  // Web pages
  'inspect_web_page',
  'discover_webmcp_tools',

  // Cross-cutting evidence and comparison
  'compare_managed_members',
  'find_changed_behavior',
  'correlate_static_and_runtime',
]

/** Every tool this plugin knows how to expose, tier by tier. */
export const ALL_CURATED_TOOLS = [...ENTRY_TOOLS, ...NAVIGATE_TOOLS, ...ANALYZE_TOOLS]

/** Tier names accepted by the `tools` config field. */
export const TIERS = {
  entry: ENTRY_TOOLS,
  navigate: NAVIGATE_TOOLS,
  analyze: ANALYZE_TOOLS,
}

/**
 * The default surface: entry points only.
 *
 * Everything beyond this is reachable on demand through `tools`, or through the
 * REA CLI (`npx rea-agents@latest ...`) which exposes the full catalog without
 * putting any of it in the model's context.
 */
export const DEFAULT_TOOLS = [...ENTRY_TOOLS]

/**
 * Workflow guidance surfaced to the model.
 *
 * REA's own skill teaches target routing and evidence discipline. This
 * condensed note preserves that behavior without shipping REA's 170-tool prose
 * into every request.
 */
export const USAGE_NOTE = `## REA (reverse engineering)

Tools prefixed \`rea__\` come from REA, which inspects shipped artifacts and
runtime behavior: native binaries, JavaScript/Electron apps, managed assemblies,
packaged archives, mobile bundles, and web pages.

Route by target before calling anything:

- ASAR or extracted JavaScript/Electron tree -> \`analyze_javascript_application\`
- Archive, package, ZIP/APK/IPA/MSIX, or DMG -> \`open_binary\`, then
  \`inspect_artifact\` when its graph helps
- Managed PE/CLI assembly -> \`inspect_managed_artifact\`
- Native executable -> \`open_binary\`, then \`binary_overview\`
- User-owned browser page -> \`list_browser_targets\`
- User-owned Electron runtime -> \`list_electron_targets\`

Rules:

- Do not call \`open_binary\` unless the target is native or an analysis database.
- Conclusions must cite the Evidence REA returns; state its coverage limits.
- Only the entry-point tools are registered. For deeper work (navigation,
  decompilation, runtime tracing, comparison) use the terminal:
  \`npx -y rea-agents@latest <command>\` exposes REA's full catalog without
  spending context on it.
- Do not use REA for ordinary source-repository architecture analysis.`
