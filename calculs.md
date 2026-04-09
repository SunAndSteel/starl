# Starlink FOV: Vérification Mathématique Complète

> Ce document extrait, vérifie (×3) et corrige tous les calculs du prompt système.
> Chaque formule est vérifiée par des points de test concrets, une analyse algébrique,
> et une vérification des cas limites.

---

## TABLE DES MATIÈRES

1. [Calcul 1 — Conversion az/el → vecteur 3D](#calcul-1)
2. [Calcul 2 — Test d'appartenance au FOV](#calcul-2)
3. [Calcul 3 — Qualité du signal](#calcul-3)  ⚠️ BUG CRITIQUE
4. [Calcul 4 — SLERP (interpolation sphérique)](#calcul-4)
5. [Calcul 5 — Rendu du cône FOV](#calcul-5)
6. [Calcul 6 — Couleur par qualité (shader)](#calcul-6)
7. [Calcul 7 — Interpolation temporelle alpha](#calcul-7)
8. [Synthèse des bugs et corrections](#synthese)
9. [Prompt corrigé intégral](#prompt-final)

---

<a name="calcul-1"></a>
## CALCUL 1 — Conversion az/el → vecteur 3D unitaire

### Formule du prompt

```python
def azel_to_xyz(az_deg, el_deg):
    az = radians(az_deg)
    el = radians(el_deg)
    x = cos(el) * sin(az)   # X = Est
    y = sin(el)              # Y = Haut (zénith)
    z = cos(el) * cos(az)   # Z = Nord
    return normalize((x, y, z))
```

Convention déclarée : az=0 → Nord, sens horaire ; el=0 → horizon, el=90° → zénith.

---

### PASSE 1 — Points de test cardinaux

| Direction     | az (°) | el (°) | x attendu | y attendu | z attendu | Calcul |
|---------------|--------|--------|-----------|-----------|-----------|--------|
| Nord          | 0      | 0      | 0         | 0         | 1         | cos(0)sin(0)=0, sin(0)=0, cos(0)cos(0)=1 ✓ |
| Est           | 90     | 0      | 1         | 0         | 0         | cos(0)sin(90°)=1, sin(0)=0, cos(0)cos(90°)=0 ✓ |
| Sud           | 180    | 0      | 0         | 0         | -1        | cos(0)sin(180°)=0, 0, cos(0)cos(180°)=-1 ✓ |
| Ouest         | 270    | 0      | -1        | 0         | 0         | cos(0)sin(270°)=-1, 0, cos(0)cos(270°)=0 ✓ |
| Zénith        | any    | 90     | 0         | 1         | 0         | cos(90°)·(...)=0, sin(90°)=1, 0 ✓ |
| Horizon Nord  | 0      | 45     | 0         | 0.707     | 0.707     | cos(45°)·0, sin(45°), cos(45°)·1 ✓ |

### PASSE 1 — Vérification norme = 1

```
|v|² = x² + y² + z²
     = cos²(el)·sin²(az) + sin²(el) + cos²(el)·cos²(az)
     = cos²(el)·[sin²(az) + cos²(az)] + sin²(el)
     = cos²(el)·1 + sin²(el)
     = 1  ✓
```

La fonction produit toujours un vecteur unitaire. `normalize()` est défensivement correct
mais algébriquement redondant (utile pour absorber les erreurs float).

---

### PASSE 2 — Cohérence avec la convention boussole

L'azimut est mesuré dans le sens horaire depuis le Nord.
- sin(az) est positif pour az ∈ ]0°, 180°[ → Est → X positif ✓
- cos(az) est positif pour az ∈ ]-90°, 90°[ → Nord → Z positif ✓
- y = sin(el) : positif pour el > 0°, nul à l'horizon, max au zénith ✓

La convention X=Est, Y=Haut, Z=Nord forme un **repère direct** (main droite) :
```
X × Y = Z  →  Est × Haut = Nord  →  (1,0,0)×(0,1,0) = (0,0,1) ✓
```

---

### PASSE 3 — Cas limites

| Cas limite         | Comportement attendu                          | Résultat |
|--------------------|-----------------------------------------------|----------|
| el = -90° (nadir)  | (0, -1, 0) — sous l'horizon                  | ✓        |
| az = 360°          | Identique à az = 0° (sin/cos périodiques)    | ✓        |
| az = -90°          | Identique à az = 270° (Ouest)                | ✓        |
| el = 0°, az = 45°  | (0.707, 0, 0.707) — Nord-Est                 | ✓        |

**VERDICT CALCUL 1 : ✅ CORRECT**

---

<a name="calcul-2"></a>
## CALCUL 2 — Test d'appartenance au FOV (produit scalaire)

### Formule du prompt

```python
cos_threshold = cos(radians(55))      # ≈ 0.5736
sat_vec  = normalize(azel_to_xyz(sat_az, sat_el))
dish_vec = normalize(azel_to_xyz(direction_az, direction_el))
cos_angle = dot(sat_vec, dish_vec)
visible   = cos_angle > cos_threshold
```

---

### PASSE 1 — Fondement géométrique

Pour deux vecteurs unitaires u et v :
```
u · v = |u||v|cos(θ) = cos(θ)    (car |u|=|v|=1)
```

Donc `dot(sat_vec, dish_vec) = cos(angle_entre_les_deux)`.

La condition `dot > cos(55°)` est équivalente à :
```
cos(θ) > cos(55°)
⟺ θ < 55°    (car cos est décroissante sur [0°, 180°])
```

Le satellite est visible si et seulement si son angle par rapport à l'axe du plat est < 55°. ✓

Valeur numérique : cos(55°) = cos(55π/180) ≈ **0.5736**

---

### PASSE 2 — Justification d'éviter arccos

```
Avec arccos :  θ = arccos(dot)  →  visible = θ < 55°
Avec dot     :  visible = dot > cos(55°)

Avantages du dot :
  1. Pas de singularité (arccos non défini pour |x| > 1)
  2. Plus rapide (évite le calcul transcendant arccos)
  3. Pas de perte de précision près des pôles (θ ≈ 0° ou 180°)
```

---

### PASSE 3 — Vérification sur cas concrets

| Satellite        | dish_vec   | angle réel | dot      | dot > 0.5736 ? | Attendu |
|------------------|------------|------------|----------|----------------|---------|
| Axe exact        | identique  | 0°         | 1.0000   | ✓              | visible |
| Bord FOV         | à 55°      | 55°        | 0.5736   | ✗ (égal, pas >) | exclus |
| Mi-chemin        | à 27.5°    | 27.5°      | 0.8870   | ✓              | visible |
| Juste dehors     | à 56°      | 56°        | 0.5592   | ✗              | exclus  |
| Horizon opposé   | à 90°      | 90°        | 0.0000   | ✗              | exclus  |

Note : le bord exact (dot == cos(55°)) est exclu par `>` (strict). C'est cohérent
avec un modèle continu — la frontière n'est pas visible. ✓

**VERDICT CALCUL 2 : ✅ CORRECT**

---

<a name="calcul-3"></a>
## CALCUL 3 — Qualité du signal

### Formule du prompt (version originale)

```python
quality = clamp(dot(sat_vec, dish_vec), 0.0, 1.0)
```

Description associée dans le prompt :
```
quality = 1.0  →  satellite parfaitement aligné  (centre du faisceau)
quality = 0.0  →  satellite au bord du FOV       (edge → rouge)
```

---

### PASSE 1 — Analyse de la plage de valeurs

Pour un satellite **visible** (qui passe le test FOV) :
```
dot(sat_vec, dish_vec) > cos(55°) ≈ 0.5736
```

Donc pour tout satellite visible :
```
quality = clamp(dot, 0, 1) ∈ [0.5736, 1.0]
```

**La qualité ne descend JAMAIS en dessous de 0.5736 pour un satellite visible.**

La formule produit donc :

| Position du satellite | dot        | quality (formule actuelle) | quality (attendue) |
|-----------------------|------------|----------------------------|--------------------|
| Centre (angle=0°)     | 1.0000     | 1.0000                     | 1.0                |
| Mi-angle (angle=27.5°)| 0.8870     | 0.8870                     | 0.5                |
| Bord FOV (angle=55°)  | 0.5736     | 0.5736                     | 0.0  ← **BUG**    |

**⚠️ BUG CRITIQUE : La qualité au bord du FOV est 0.574, pas 0.0.**
Le shader n'affichera jamais de rouge pour les satellites visibles.

---

### PASSE 2 — Démonstration algébrique du bug

```
Le mapping couleur dans le shader attend :
  q = 0.0  →  rouge   (bord FOV)
  q = 0.5  →  jaune
  q = 1.0  →  vert    (centre)

La formule clamp(dot, 0, 1) produit :
  Au bord FOV  : q ≈ 0.574  →  couleur = jaune-vert  ← JAMAIS rouge
  Au centre    : q = 1.0    →  vert                  ✓

La plage réelle utilisée est [0.574, 1.0], pas [0.0, 1.0].
Seuls 42.6% de la plage de couleurs est utilisée.
Le rouge et l'orange ne sont JAMAIS affichés.
```

---

### PASSE 3 — Correction et vérification

**Formule corrigée :**

```python
COS_HALF = cos(radians(55))          # ≈ 0.5736
RANGE    = 1.0 - COS_HALF           # ≈ 0.4264

raw     = dot(sat_vec, dish_vec)     # ∈ [cos(55°), 1.0] pour visible
quality = clamp((raw - COS_HALF) / RANGE, 0.0, 1.0)
```

**Vérification :**

| Position          | dot    | raw - COS_HALF | / RANGE | clamp | quality |
|-------------------|--------|----------------|---------|-------|---------|
| Centre (angle=0°) | 1.0000 | 0.4264         | 1.0000  | 1.0   | ✓ vert  |
| angle=27.5°       | 0.8870 | 0.3134         | 0.7351  | 0.735 | ≈ jaune-vert |
| Milieu exact      | 0.7868 | 0.2132         | 0.5000  | 0.5   | ✓ jaune |
| Bord FOV (55°)    | 0.5736 | 0.0000         | 0.0000  | 0.0   | ✓ rouge |

Le milieu de qualité (q=0.5) correspond à l'angle : `arccos(0.7868) ≈ 38.0°`
soit exactement 38° sur les 55° du demi-angle → cohérent avec un gradient linéaire. ✓

RANGE = 0.4264 > 0 → pas de division par zéro possible. ✓

**VERDICT CALCUL 3 : ❌ BUG CRITIQUE dans la formule originale**
**→ Formule corrigée : `clamp((dot - cos(55°)) / (1 - cos(55°)), 0.0, 1.0)`**

---

<a name="calcul-4"></a>
## CALCUL 4 — SLERP (Spherical Linear Interpolation)

### Formule du prompt

```javascript
function slerp(v0, v1, t) {
    let dot = clamp(v0·v1, -1.0, 1.0);
    const theta    = Math.acos(dot);
    if (Math.abs(theta) < 1e-6) return v0;
    const sinTheta = Math.sin(theta);
    const s0 = Math.sin((1 - t) * theta) / sinTheta;
    const s1 = Math.sin(t * theta) / sinTheta;
    return s0*v0 + s1*v1;
}
```

---

### PASSE 1 — Conditions aux bornes

**t = 0 :**
```
s0 = sin((1-0)·θ) / sin(θ) = sin(θ)/sin(θ) = 1
s1 = sin(0·θ) / sin(θ) = 0/sin(θ) = 0
résultat = 1·v0 + 0·v1 = v0  ✓
```

**t = 1 :**
```
s0 = sin(0·θ) / sin(θ) = 0
s1 = sin(1·θ) / sin(θ) = 1
résultat = 0·v0 + 1·v1 = v1  ✓
```

**t = 0.5 :**
```
s0 = sin(θ/2) / sin(θ) = sin(θ/2) / (2·sin(θ/2)·cos(θ/2)) = 1/(2·cos(θ/2))
s1 = idem par symétrie = s0
résultat = s0·(v0 + v1)   →  pointe vers le milieu du grand arc  ✓
```

---

### PASSE 2 — Le résultat est-il un vecteur unitaire ?

```
|résultat|² = s0²|v0|² + 2·s0·s1·(v0·v1) + s1²|v1|²
            = s0² + 2·s0·s1·cos(θ) + s1²

En substituant :
= [sin²((1-t)θ) + 2·sin((1-t)θ)·sin(tθ)·cos(θ) + sin²(tθ)] / sin²(θ)

Identité trigonométrique : 2·sin(A)·sin(B) = cos(A-B) - cos(A+B)
Avec A=(1-t)θ, B=tθ :
  2·sin((1-t)θ)·sin(tθ) = cos((1-2t)θ) - cos(θ)

Numérateur = sin²((1-t)θ) + sin²(tθ) + [cos((1-2t)θ) - cos(θ)]·cos(θ)

Identité : sin²X = (1 - cos(2X))/2

= (1-cos(2(1-t)θ))/2 + (1-cos(2tθ))/2 + cos((1-2t)θ)·cos(θ) - cos²(θ)

Remarquer que (1-2t)θ = (1-t)θ - tθ, et cos((1-2t)θ)·cos(θ) développé avec
cos(A)cos(B) = (cos(A+B)+cos(A-B))/2 → avec A=(1-2t)θ, B=θ :

cos((1-2t)θ)·cos(θ) = [cos((2-2t)θ) + cos(-2tθ)] / 2
                     = [cos(2(1-t)θ) + cos(2tθ)] / 2

En substituant dans le numérateur :
= 1/2 - cos(2(1-t)θ)/2 + 1/2 - cos(2tθ)/2
  + cos(2(1-t)θ)/2 + cos(2tθ)/2 - cos²(θ)
= 1 - cos²(θ)
= sin²(θ)

Donc |résultat|² = sin²(θ)/sin²(θ) = 1  ✓
```

**La SLERP produit toujours un vecteur unitaire.** ✓

---

### PASSE 3 — Cas limites et stabilité numérique

| Cas                    | theta         | Comportement                           | Statut |
|------------------------|---------------|----------------------------------------|--------|
| v0 ≈ v1                | ≈ 0           | `return v0` (guard 1e-6)              | ✓      |
| v0 = -v1 (antipodaux)  | = π           | Indéfini (infinité de géodésiques)    | ⚠️     |
| t ∉ [0,1]              | quelconque    | Extrapolation (non voulu, documenter) | ⚠️     |
| dot hors [-1,1] (float)| impossible    | clamp évite acos(NaN)                 | ✓      |

Pour le cas antipodal (θ≈π) : en pratique impossible pour deux satellites
dans le même FOV (angle max = 110°, pas 180°). ✓

**Pourquoi SLERP empêche le recul et la téléportation :**

```
Interpolation naïve az/el :
  t=0 : az=350°
  t=1 : az=10°
  t=0.5 (naïf) : az=180°  ← satellite traverse le ciel EN SENS INVERSE

SLERP en 3D :
  v0 = azel_to_xyz(350°, el)  →  vecteur légèrement à l'ouest du Nord
  v1 = azel_to_xyz(10°, el)   →  vecteur légèrement à l'est du Nord
  slerp(v0, v1, 0.5)           →  vecteur exactement au Nord  ✓
  (chemin minimal sur la sphère, jamais supérieur à 180°)
```

**VERDICT CALCUL 4 : ✅ CORRECT** (cas antipodal sans objet dans le contexte FOV)

---

<a name="calcul-5"></a>
## CALCUL 5 — Rendu du cône FOV (cercle de bord)

### Formule du prompt

```javascript
// dish_vec, u, v : base orthonormée
// u ⊥ dish_vec, v ⊥ dish_vec, u ⊥ v

for (let i = 0; i < N; i++) {
    const phi   = 2 * Math.PI * i / N;
    const point = cos(55°) * dish_vec
                + sin(55°) * (cos(phi) * u + sin(phi) * v);
    normalize(point);  // sécurité numérique
}
```

---

### PASSE 1 — Le point est-il sur la sphère unité ?

```
|point|² = |cos(α)·dish_vec + sin(α)·(cos(φ)·u + sin(φ)·v)|²

En développant (dish_vec, u, v orthonormés) :
= cos²(α)·|dish_vec|² + sin²(α)·(cos²(φ)·|u|² + sin²(φ)·|v|²)
  + 2·cos(α)·sin(α)·cos(φ)·(dish_vec·u)     = 0
  + 2·cos(α)·sin(α)·sin(φ)·(dish_vec·v)     = 0
  + 2·sin²(α)·cos(φ)·sin(φ)·(u·v)           = 0

= cos²(α)·1 + sin²(α)·(cos²(φ) + sin²(φ))·1
= cos²(α) + sin²(α)
= 1  ✓
```

Tous les points du cercle sont sur la sphère unité. `normalize()` est redondant
mais inoffensif (absorption des erreurs flottantes). ✓

---

### PASSE 2 — Le point est-il exactement sur le bord du FOV ?

```
dot(point, dish_vec) = cos(α)·(dish_vec·dish_vec)
                     + sin(α)·cos(φ)·(u·dish_vec)
                     + sin(α)·sin(φ)·(v·dish_vec)
= cos(α)·1 + sin(α)·0 + sin(α)·0
= cos(α) = cos(55°)  ✓
```

Chaque point du cercle rendu satisfait **exactement** le seuil de visibilité du backend.
Il n'y a aucun écart entre le cône rendu et le cône utilisé pour filtrer. ✓

---

### PASSE 3 — Construction de la base orthonormée (u, v)

La procédure standard est :
```javascript
function buildBasis(dish_vec) {
    // Choisir un vecteur non colinéaire à dish_vec
    const arbitrary = (Math.abs(dish_vec[1]) < 0.99)
                    ? [0, 1, 0]    // haut
                    : [1, 0, 0];   // est (si dish pointe quasi au zénith)
    const u = normalize(cross(dish_vec, arbitrary));
    const v = cross(dish_vec, u);  // déjà unitaire si dish_vec et u le sont
    return { u, v };
}
```

Vérification : si dish pointe au zénith (0,1,0) et arbitrary=(1,0,0) :
```
u = normalize(cross((0,1,0), (1,0,0))) = normalize((0·0-0·0, 0·1-0·0, 0·0-1·1))
  = normalize((0, 0, -1)) = (0, 0, -1)  →  u ⊥ dish_vec ✓
v = cross((0,1,0), (0,0,-1)) = (1·(-1)-0·0, 0·0-0·(-1), 0·0-1·0) = (-1, 0, 0)  ✓
```

**VERDICT CALCUL 5 : ✅ CORRECT**

---

<a name="calcul-6"></a>
## CALCUL 6 — Couleur par qualité (GLSL shader)

### Formule du prompt

```glsl
vec3 qualityToColor(float q) {
    if (q > 0.5) {
        float t = (q - 0.5) * 2.0;
        return mix(vec3(1.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), t);
    } else {
        float t = q * 2.0;
        return mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), t);
    }
}
```

---

### PASSE 1 — Vérification aux points clés

| q      | Branche | t       | mix(A, B, t)                          | Couleur  |
|--------|---------|---------|---------------------------------------|----------|
| 0.000  | q ≤ 0.5 | 0.000   | mix(rouge, jaune, 0) = (1,0,0)        | rouge ✓  |
| 0.250  | q ≤ 0.5 | 0.500   | mix(rouge, jaune, 0.5) = (1,0.5,0)   | orange ✓ |
| 0.500  | q ≤ 0.5 | 1.000   | mix(rouge, jaune, 1) = (1,1,0)        | jaune ✓  |
| 0.500  | q > 0.5 | 0.000   | mix(jaune, vert, 0) = (1,1,0)         | jaune ✓  |
| 0.750  | q > 0.5 | 0.500   | mix(jaune, vert, 0.5) = (0.5,1,0)    | vert-j.✓ |
| 1.000  | q > 0.5 | 1.000   | mix(jaune, vert, 1) = (0,1,0)         | vert ✓   |

---

### PASSE 2 — Continuité à q = 0.5

```
Branche q ≤ 0.5 : lim q→0.5⁻  t = 0.5*2 = 1.0
  mix(rouge, jaune, 1.0) = jaune = (1,1,0)

Branche q > 0.5 : lim q→0.5⁺  t = (0.5-0.5)*2 = 0.0
  mix(jaune, vert, 0.0) = jaune = (1,1,0)

Les deux branches donnent (1,1,0) en q=0.5 → fonction continue ✓
```

---

### PASSE 3 — Interaction avec le bug du Calcul 3

```
Avec la formule de qualité ORIGINALE (buguée) :
  Les satellites visibles ont q ∈ [0.574, 1.0]
  → La fonction couleur produit des teintes de jaune-vert à vert uniquement
  → Le rouge (q < 0.5) n'est JAMAIS affiché pour des satellites visibles
  → L'orange n'est JAMAIS affiché non plus

Avec la formule de qualité CORRIGÉE (Calcul 3) :
  Les satellites visibles ont q ∈ [0.0, 1.0]
  → Toute la plage rouge→jaune→vert est utilisée ✓
  → Le bord du FOV apparaît rouge, le centre apparaît vert ✓
```

**La fonction qualityToColor est correcte en elle-même, mais requiert
le correctif du Calcul 3 pour produire l'effet visuel attendu.**

**VERDICT CALCUL 6 : ✅ CORRECT** (conditionnel au fix Calcul 3)

---

<a name="calcul-7"></a>
## CALCUL 7 — Interpolation temporelle alpha

### Formule du prompt

```javascript
// p_i.t ≤ t_now < p_{i+1}.t
const alpha = (t_now - p_i.t) / (p_{i+1}.t - p_i.t);
const pos3d = slerp(
    azelToXYZ(p_i.az, p_i.el),
    azelToXYZ(p_{i+1}.az, p_{i+1}.el),
    alpha
);
```

---

### PASSE 1 — Conditions aux bornes

```
t_now = p_i.t     → alpha = 0 / dt = 0  → slerp retourne v_i  ✓
t_now = p_{i+1}.t → alpha = dt / dt = 1  → slerp retourne v_{i+1}  ✓
t_now = milieu     → alpha = 0.5          → slerp retourne le mi-arc ✓
```

---

### PASSE 2 — Risque de division par zéro

```
Dénominateur = p_{i+1}.t - p_i.t = dt

Si dt = 0 (deux points au même instant) → division par zéro → NaN → artefacts

Avec la contrainte dt ≤ 2s et SGP4 à taux fixe, dt > 0 est garanti.
Mais en défense :
```

```javascript
const dt = p_{i+1}.t - p_i.t;
const alpha = (dt < 1e-9) ? 0.0 : (t_now - p_i.t) / dt;
```

---

### PASSE 3 — Dépassement de plage (extrapolation)

```
Si t_now > p_{i+1}.t (pas de point suivant trouvé) → alpha > 1
Si t_now < p_i.t (point trop récent)               → alpha < 0

SLERP avec alpha hors [0,1] extrapole hors de l'arc → position erronée.

Contraintes à enforcer côté frontend :
  1. Ne jamais interpoler en dehors d'un segment valide (t_entry ≤ t_now ≤ t_exit)
  2. Ne jamais réutiliser la dernière position après t_exit
  3. Clamp alpha : alpha = clamp(alpha, 0.0, 1.0)
```

**VERDICT CALCUL 7 : ✅ CORRECT** (avec garde division-zéro et clamp alpha recommandés)

---

<a name="synthese"></a>
## SYNTHÈSE DES BUGS ET CORRECTIONS

| # | Calcul              | Statut      | Problème                                                      | Correction                                               |
|---|---------------------|-------------|---------------------------------------------------------------|----------------------------------------------------------|
| 1 | azel_to_xyz         | ✅ Correct  | —                                                             | Aucune                                                   |
| 2 | Test FOV (dot)      | ✅ Correct  | —                                                             | Aucune                                                   |
| 3 | Qualité du signal   | ❌ **BUG**  | clamp(dot,0,1) → edge=0.574 pas 0.0 → pas de rouge           | `(dot - cos55°) / (1 - cos55°)` puis clamp              |
| 4 | SLERP               | ✅ Correct  | Cas antipodal théorique (sans objet en pratique)              | Aucune (documenter)                                      |
| 5 | Cône FOV            | ✅ Correct  | —                                                             | Ajouter buildBasis() explicite                           |
| 6 | qualityToColor      | ✅ Correct* | Correct en soi, inutilisable sans fix Calcul 3                | Dépend du fix Calcul 3                                   |
| 7 | Alpha interp.       | ✅ Correct  | Division par zéro théorique, alpha hors [0,1] possible        | Garde dt < 1e-9, clamp alpha                             |

