# Deft employee plugin for Hermes

Install under `$HERMES_HOME/plugins/deft-employee` and enable the plugin. It
uses Hermes hooks and registers four narrow Deft workspace tools for governed
attachment reads, reviewed workspace-plan imports, and reviewed document
sharing. Those tools inject the authenticated employee identity and delegate to
Deft's existing MCP server; they do not replace Hermes core tools, planning,
delegation, browser, terminal, memory, or general MCP support.

The plugin also registers the read-only `deft-employee:runtime` skill. The
bundled `deft-platform` adapter auto-loads it into each new Deft session so a
stock Hermes installation receives Deft assignment and tool-outcome rules
without any Hermes source patch.

Required environment: `DEFT_MCP_URL`, `DEFT_MCP_TOKEN`, and
`DEFT_EMPLOYEE_SLUG`. Optional `DEFT_EMPLOYEE_POLICY_JSON` can set:

```json
{
  "allow_external_writes": false,
  "forbidden_tools": [],
  "budgets": { "max_tool_calls": 100 },
  "assignment": { "outcome": "Research and report", "deadline": null }
}
```

External writes default to blocked until an assignment policy allows them.
The plugin reports only bounded, credential-redacted summaries to Deft.
