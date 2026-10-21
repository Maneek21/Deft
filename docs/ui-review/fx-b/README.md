# FX-B Host UI evidence

Isolated before/after renders of the actual React components using synthetic, fixed owner/account state and the app Tailwind theme. Before uses origin/master a21f2929. No live account actions were performed. Viewports are 1440 x 900 and 390 x 844.

Settings health appears above the fold; maintenance is collapsed. The admin card leads with installation state, with technical details under Manage app. Connection details distinguish a successful saved-copy sync from later source changes. Unavailable saved items offer a plain-language explanation and a connection link.

The existing owner-safe observation schema has no last-sync timestamp or total count, so settings displays only verified connection/refresh state. It does not reuse the admin-only management endpoint or invent these values.
