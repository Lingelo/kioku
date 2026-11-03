#!/bin/sh
# Installation de Kioku sur une machine, une fois : le plugin depuis la marketplace dojo, et le relais `kioku` dans
# le PATH pour les scripts npm des coffres.
#
#   sh install.sh <owner>/dojo     (le depot de la marketplace dojo)
#
# Etapes : prerequis -> marketplace dojo -> plugin kioku@dojo au niveau utilisateur -> relais `kioku`
# (copie depuis le plugin installe : ni clone ni jeton) -> verification. Idempotent : relancer apres une mise a jour du
# plugin remet le relais a jour. Le plugin se met a jour par Claude Code si la marketplace a l'auto-update (voir la fin).
# Ensuite : un coffre se cree par /kioku:setup dans un dossier vide, ou kioku init <dossier>.
set -eu

MARKET_REPO="${1:-}"
PLUGIN="kioku@dojo"
RELAY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/kioku-relay"
BIN_DIR="$HOME/.local/bin"

die() { printf 'install : %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

step "Prerequis"
command -v node >/dev/null 2>&1 || die "node introuvable (20 ou plus requis)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || die "Node $(node --version) : 20 ou plus requis"
command -v git >/dev/null 2>&1 || die "git introuvable"
command -v claude >/dev/null 2>&1 || die "claude (Claude Code) introuvable : https://docs.claude.com/claude-code"
case "$MARKET_REPO" in
  */dojo) ;;
  *) die "usage : sh install.sh <owner>/dojo (le depot GitHub de la marketplace dojo)" ;;
esac

step "Marketplace $MARKET_REPO"
# Deja declaree : claude le dit et sort en erreur ; on ne s'arrete pas pour autant.
claude plugin marketplace add "$MARKET_REPO" || printf 'note : marketplace deja declaree, ou echec ci-dessus\n'
claude plugin marketplace update dojo >/dev/null 2>&1 || true

step "Plugin $PLUGIN (niveau utilisateur)"
claude plugin install "$PLUGIN" --scope user || die "echec de claude plugin install $PLUGIN"
claude plugin update "$PLUGIN" >/dev/null 2>&1 || true

step "Relais kioku dans le PATH"
# Le plugin installe au niveau utilisateur, le plus recent : son dossier dans le cache de Claude Code.
INSTALL=$(node -e '
  const fs = require("fs"), path = require("path");
  const file = path.join(process.argv[1], ".claude", "plugins", "installed_plugins.json");
  const all = JSON.parse(fs.readFileSync(file, "utf8")).plugins?.["kioku@dojo"] ?? [];
  const ok = all.filter((i) => i.scope === "user" && i.installPath && fs.existsSync(path.join(i.installPath, "bin", "kioku-relay.mjs")))
    .sort((a, b) => String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")));
  if (!ok.length) process.exit(1);
  console.log(ok[0].installPath);
' "$HOME") || die "plugin installe introuvable dans ~/.claude/plugins/installed_plugins.json (ou trop ancien : sans bin/kioku-relay.mjs)"
mkdir -p "$RELAY_DIR" "$BIN_DIR"
cp "$INSTALL/bin/kioku-relay.mjs" "$INSTALL/tools/plugin-install.mjs" "$RELAY_DIR/"
chmod +x "$RELAY_DIR/kioku-relay.mjs"
ln -sf "$RELAY_DIR/kioku-relay.mjs" "$BIN_DIR/kioku"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'note : %s n est pas dans le PATH ; ajoute a ton profil : export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac
if [ -n "${KIOKU_HOME:-}" ]; then printf 'note : KIOKU_HOME=%s est pose : le relais utilisera ce core, pas le plugin\n' "$KIOKU_HOME"; fi

step "Verification"
# Hors coffre, sans argument : le relais doit trouver le core et en afficher l'usage (code 1 du CLI = usage, attendu).
out=$(cd "$(mktemp -d)" && "$BIN_DIR/kioku" 2>&1) || true
printf '%s\n' "$out" | grep -q '^usage :' || die "le relais ne trouve pas de core : $out"
printf 'plugin : %s\nrelais : %s -> %s\n' "$INSTALL" "$BIN_DIR/kioku" "$RELAY_DIR/kioku-relay.mjs"
cat <<EOF

Pret. Ensuite :
  - mise a jour automatique (desactivee par defaut pour une marketplace tierce) : /plugin > Marketplaces >
    dojo > Enable auto-update
  - nouveau coffre : dans un dossier vide, claude puis /kioku:setup (ou kioku init <dossier>)
  - coffre existant : cd <coffre> && kioku upgrade (simulation), puis kioku upgrade --write, puis kioku doctor --live
EOF
