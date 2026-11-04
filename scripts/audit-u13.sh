#!/bin/sh
# Audit avant publication d'un dépôt public (core Kioku, ou toute marketplace qui le copie) — lecture seule.
# Ne modifie ni le dépôt ni GitHub. Rapport : $OUT/rapport.txt
#
# Usage :
#   REPO=<owner>/<depot> KIOKU_DENYLIST=<fichier> \
#   KIOKU_FORBIDDEN_KEYS='SHA256:… SHA256:…' KIOKU_FORBIDDEN_EMAILS='@employeur\.example|@client\.example' \
#   [ORPHAN_OBJECTS='<sha court> …'] sh scripts/audit-u13.sh
#
# Prérequis : git, node, gh connecté (clone HTTPS sans clé SSH), gitleaks (brew install gitleaks).
# Les valeurs privées (denylist, empreintes, motifs d'e-mail, objets à traquer) arrivent par l'environnement et ne
# sont jamais écrites ici. Une variable absente rend le contrôle « NON FAIT » et l'audit en échec : il n'y a pas de
# succès silencieux.
#
# Un clone miroir FRAIS depuis GitHub est audité, pas le clone local : c'est ce qui est public qui compte (branches,
# tags, refs/pull/*), et un clone local peut porter des refs jamais poussées ou en manquer.

set -u
: "${REPO:?REPO=<owner>/<depot> requis}"
OUT=/tmp/kioku-audit-$(echo "$REPO" | tr '/' '-')
# Le contrôleur de denylist est celui du core, même pour auditer un autre dépôt (qui n'a pas le sien)
DENYCHECK="$(cd "$(dirname "$0")/.." && pwd)/tools/denylist-check.mjs"
DENY="${KIOKU_DENYLIST:-}"
rm -rf "$OUT"; mkdir -p "$OUT"
R="$OUT/rapport.txt"
say() { echo "$*" | tee -a "$R"; }
fail=0

say "# Audit avant publication $REPO — $(date '+%Y-%m-%d %H:%M')"

# 0. Clone miroir (toutes les refs publiques), en HTTPS via gh pour ne pas dépendre de la clé SSH
say "## 0. clone miroir"
if ! git -c credential.helper= -c credential.helper='!gh auth git-credential' clone -q --mirror "https://github.com/$REPO.git" "$OUT/mirror.git"; then
  say "ECHEC clone : audit impossible"; exit 2
fi
git clone -q "$OUT/mirror.git" "$OUT/work"
say "refs publiques :"; git -C "$OUT/mirror.git" for-each-ref --format='  %(refname) %(objectname:short)' | tee -a "$R"
say "commits : $(git -C "$OUT/mirror.git" rev-list --all | wc -l | tr -d ' ')"

# 1. Denylist : arbre courant puis tout l'historique (diffs, messages, auteurs, refs)
say "## 1. denylist (tree + history)"
if [ ! -s "$DENY" ]; then say "ECHEC : $DENY absent ou vide"; fail=1; else
  for mode in tree history; do
    ( cd "$OUT/work" && git fetch -q origin '+refs/*:refs/remotes/origin/*' 2>/dev/null
      KIOKU_DENYLIST="$DENY" node "$DENYCHECK" "$mode" ) > "$OUT/denylist-$mode.txt" 2>&1
    code=$?
    say "  $mode : code $code (0 = rien trouvé, 1 = terme trouvé, 2 = contrôle impossible)"
    [ $code -ne 0 ] && { sed 's/^/    /' "$OUT/denylist-$mode.txt" | tee -a "$R"; fail=1; }
  done
fi

# 2. Secrets : gitleaks sur tout l'historique du miroir
say "## 2. secrets (gitleaks, tout l'historique)"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git "$OUT/mirror.git" --log-opts="--all" --redact --no-banner \
    --report-format json --report-path "$OUT/gitleaks.json" > "$OUT/gitleaks.log" 2>&1
  code=$?
  n=$(python3 -I -c "import json;print(len(json.load(open('$OUT/gitleaks.json'))))" 2>/dev/null || echo '?')
  say "  code $code, fuites : $n (détail rédigé : $OUT/gitleaks.json)"
  [ "$code" -ne 0 ] && fail=1
else
  say "  NON FAIT : gitleaks absent (brew install gitleaks), puis relancer"; fail=1
fi

# 3. Objets orphelins connus (un objet poussé puis retiré de l'historique) : un objet non référencé ne vient pas au
#    clone ; on vérifie le miroir, l'API (commit) et la page web. Un blob ne se cherche par l'API qu'avec son SHA complet.
say "## 3. objets orphelins (ORPHAN_OBJECTS)"
if [ -z "${ORPHAN_OBJECTS:-}" ]; then
  say "  aucun objet à traquer (ORPHAN_OBJECTS vide)"
else
  for o in $ORPHAN_OBJECTS; do
    if git -C "$OUT/mirror.git" cat-file -e "$o" 2>/dev/null; then
      say "  $o : PRESENT dans le miroir ($(git -C "$OUT/mirror.git" cat-file -t "$o"), atteint par une ref publique)"; fail=1
    else say "  $o : absent du miroir"; fi
    if gh api "repos/$REPO/commits/$o" --jq .sha >/dev/null 2>&1; then
      say "  $o : GitHub le sert encore comme commit (orphelin non purgé) -> support GitHub"; fail=1
    else say "  $o : l'API ne le sert pas comme commit"; fi
    say "  $o : page web HTTP $(curl -s -o /dev/null -w '%{http_code}' "https://github.com/$REPO/commit/$o")"
  done
fi
say "  forks publics : $(gh api "repos/$REPO/forks" --jq length 2>/dev/null)"
say "  PR (toutes, les refs refs/pull/* gardent des objets) : $(gh api "repos/$REPO/pulls?state=all" --jq length 2>/dev/null)"

# 4. Auteur et copyright neutres
say "## 4. auteur et copyright"
say "  auteurs/commiteurs (tout l'historique) :"
git -C "$OUT/mirror.git" log --all --format='%an <%ae> | %cn <%ce>' | sort | uniq -c | sed 's/^/    /' | tee -a "$R"
# 4b. Identités interdites : clés de signature et e-mails d'auteur/commiteur. La denylist ne lit pas les blocs gpgsig,
#     et un e-mail d'employeur dans %ae/%ce est une fuite même si le nom est neutre. Valeurs privées, hors dépôt :
#       KIOKU_FORBIDDEN_KEYS   empreintes SHA256:… séparées par des espaces (défaut : vide = contrôle « clés » non fait)
#       KIOKU_FORBIDDEN_EMAILS motifs grep -E sur l'e-mail (ex. '@employeur\.com$')
say "## 4b. identités interdites (signatures, e-mails)"
signed=$(git -C "$OUT/mirror.git" log --all --format='%GK' | grep -c . || true)
say "  commits signés : $signed / $(git -C "$OUT/mirror.git" rev-list --all | wc -l | tr -d ' ') (une signature, même d'une clé inconnue, est un identifiant stable)"
git -C "$OUT/mirror.git" log --all --format='%GK' | grep . | sort | uniq -c | sed 's/^/    clé /' | tee -a "$R"
if [ -n "${KIOKU_FORBIDDEN_KEYS:-}" ]; then
  for k in $KIOKU_FORBIDDEN_KEYS; do
    n=$(git -C "$OUT/mirror.git" log --all --format='%GK' | grep -cxF "$k" || true)
    if [ "$n" -gt 0 ]; then
      say "  INTERDIT : $n commit(s) signés par $k :"; fail=1
      git -C "$OUT/mirror.git" log --all --format='%h %ad %GK' --date=short | grep -F "$k" | sed 's/^/    /' | tee -a "$R"
    else say "  clé $k : absente"; fi
  done
else
  say "  NON FAIT : KIOKU_FORBIDDEN_KEYS non défini (empreintes interdites)"; fail=1
fi
if [ -n "${KIOKU_FORBIDDEN_EMAILS:-}" ]; then
  hits=$(git -C "$OUT/mirror.git" log --all --format='%h %ae %ce' | awk '{print $1" "$2"\n"$1" "$3}' | grep -iE " .*(${KIOKU_FORBIDDEN_EMAILS})" || true)
  if [ -n "$hits" ]; then say "  INTERDIT : e-mails d'auteur/commiteur :"; echo "$hits" | sort -u | sed 's/^/    /' | tee -a "$R"; fail=1
  else say "  e-mails interdits : aucun"; fi
  tree=$(git -C "$OUT/work" grep -n -I -iE "$KIOKU_FORBIDDEN_EMAILS" -- . ':!tools/dashboard/vendor' | cut -c1-160 || true)
  [ -n "$tree" ] && { say "  INTERDIT dans l'arbre :"; echo "$tree" | sed 's/^/    /' | tee -a "$R"; fail=1; }
else
  say "  NON FAIT : KIOKU_FORBIDDEN_EMAILS non défini (motifs d'e-mail interdits)"; fail=1
fi
say "  LICENSE : $(sed -n '3p' "$OUT/work/LICENSE")"
say "  fichiers contenant 'Copyright' :"
git -C "$OUT/work" grep -n -I -i "copyright" -- . ':!tools/dashboard/vendor' | cut -c1-160 | sed 's/^/    /' | tee -a "$R"

# 5. Licences des polices (OFL) et des fichiers vendor
say "## 5. licences vendor"
say "  polices : $(git -C "$OUT/work" ls-files 'tools/dashboard/vendor/fonts/*' | wc -l | tr -d ' ') fichiers"
for f in $(git -C "$OUT/work" ls-files 'tools/dashboard/vendor/fonts/*' | grep -iE 'ofl|licen'); do say "    licence présente : $f"; done
say "  la licence OFL.txt couvre-t-elle Inter ET JetBrains Mono ? (en-têtes Copyright) :"
grep -n "Copyright" "$OUT/work/tools/dashboard/vendor/fonts/OFL.txt" 2>/dev/null | sed 's/^/    /' | tee -a "$R"
say "  autres vendor :"
git -C "$OUT/work" ls-files 'tools/dashboard/vendor/*' | grep -v fonts/ | sed 's/^/    /' | tee -a "$R"
say "  chaque .min.js a-t-il sa notice (fichier LICENSE-<nom>.txt à côté) ?"
for f in $(git -C "$OUT/work" ls-files 'tools/dashboard/vendor/*.js'); do
  lic="$(dirname "$f")/LICENSE-$(basename "$f" .min.js).txt"
  if [ -f "$OUT/work/$lic" ]; then say "    $f : notice $lic"
  else say "    $f : NOTICE ABSENTE ($lic)"; fail=1; fi
done

# 6. Contrôles complémentaires (non exigés par U13, peu coûteux)
say "## 6. complémentaires"
say "  fichiers > 1 Mo dans l'historique :"
git -C "$OUT/mirror.git" rev-list --objects --all | git -C "$OUT/mirror.git" cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' \
  | awk '$1=="blob" && $2>1048576 {print "    "$2" "$3}' | tee -a "$R"
say "  chemins absolus personnels (/Users/, /home/) dans l'arbre :"
git -C "$OUT/work" grep -n -I -E "/Users/[a-z]|/home/[a-z]" -- . ':!tools/dashboard/vendor' | cut -c1-160 | sed 's/^/    /' | tee -a "$R"
say "  adresses e-mail dans l'arbre (hors noreply) :"
git -C "$OUT/work" grep -n -I -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}" -- . ':!tools/dashboard/vendor' | grep -v noreply | sort -u | sed 's/^/    /' | tee -a "$R"

say "## Bilan : $( [ $fail -eq 0 ] && echo 'aucun signal bloquant détecté (relecture humaine requise)' || echo 'SIGNAUX A TRAITER, voir ci-dessus')"
say "Rapport : $R"
exit $fail
