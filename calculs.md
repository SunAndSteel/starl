# Starlink FOV: version lisible pour humain

Ce document résume les calculs utiles pour un modèle de champ de vision (FOV) physiquement cohérent pour une parabole Starlink Gen 3.

L'objectif n'est pas de refaire un audit mathématique ligne par ligne, mais de répondre clairement à quatre questions :

1. Comment convertir un azimut et une élévation en direction 3D ?
2. Comment savoir si un satellite est dans le cône de visibilité ?
3. Comment calculer une qualité de signal exploitable visuellement ?
4. Comment animer et afficher tout ça sans incohérences ?

---

## Résumé rapide

- La conversion `az/el -> vecteur 3D` est correcte.
- Le test FOV par produit scalaire est correct et préférable à `arccos`.
- La formule de qualité d'origine est fausse pour l'usage visuel.
- La correction consiste à remapper `dot` entre `cos(55°)` et `1`.
- La SLERP est la bonne solution pour éviter les retours en arrière à cause du wrap-around d'azimut.
- Le cercle de bord du FOV est correct si le frontend et le backend utilisent exactement le même repère 3D.
- L'interpolation temporelle doit protéger contre `dt = 0` et limiter `alpha` à `[0, 1]`.

---

## Convention de coordonnées

Tout repose sur la même convention, partout :

- `X = Est`
- `Y = Haut`
- `Z = Nord`
- `az = 0°` vers le Nord
- `az` augmente dans le sens horaire
- `el = 0°` à l'horizon
- `el = 90°` au zénith

Si le backend, le frontend, les shaders ou la projection du ciel utilisent des conventions différentes, les satellites, le cône FOV et la carte d'obstruction ne s'aligneront pas.

---

<a name="calcul-1"></a>
## 1. Conversion azimut/élévation vers un vecteur 3D

La formule de base est :

```python
def azel_to_xyz(az_deg, el_deg):
    az = radians(az_deg)
    el = radians(el_deg)
    x = cos(el) * sin(az)   # Est
    y = sin(el)             # Haut
    z = cos(el) * cos(az)   # Nord
    return normalize((x, y, z))
```

### Intuition

- `cos(el)` mesure la partie "horizontale" de la direction.
- `sin(el)` mesure la partie "verticale".
- Sur le plan horizontal :
  - `sin(az)` envoie vers l'Est/Ouest
  - `cos(az)` envoie vers le Nord/Sud

### Vérifications simples

| Direction | az | el | Résultat attendu |
|---|---:|---:|---|
| Nord | `0°` | `0°` | `(0, 0, 1)` |
| Est | `90°` | `0°` | `(1, 0, 0)` |
| Sud | `180°` | `0°` | `(0, 0, -1)` |
| Ouest | `270°` | `0°` | `(-1, 0, 0)` |
| Zénith | n'importe | `90°` | `(0, 1, 0)` |

### Pourquoi c'est unitaire

La norme vaut toujours 1 :

```text
|v|² = cos²(el) sin²(az) + sin²(el) + cos²(el) cos²(az)
     = cos²(el) [sin²(az) + cos²(az)] + sin²(el)
     = cos²(el) + sin²(el)
     = 1
```

En pratique, `normalize()` reste utile comme sécurité numérique.

### Conclusion

Ce calcul est correct.

---

<a name="calcul-2"></a>
## 2. Test d'appartenance au FOV

La parabole a un FOV total d'environ `110°`, donc un demi-angle de `55°`.

On calcule :

```python
COS_HALF = cos(radians(55))   # ~ 0.5736

sat_vec  = normalize(azel_to_xyz(sat_az, sat_el))
dish_vec = normalize(azel_to_xyz(direction_az, direction_el))

visible = dot(sat_vec, dish_vec) > COS_HALF
```

### Pourquoi ça marche

Pour deux vecteurs unitaires `u` et `v` :

```text
u · v = cos(theta)
```

Donc :

```text
dot(sat_vec, dish_vec) > cos(55°)
<=> angle(sat, dish) < 55°
```

On teste donc directement si le satellite est à l'intérieur du cône.

### Pourquoi il ne faut pas utiliser `arccos`

Utiliser `arccos(dot)` pour retrouver l'angle est inutile :

- c'est plus lent
- c'est plus fragile numériquement
- le produit scalaire suffit déjà pour comparer à un angle seuil

En clair :

```text
au lieu de faire : arccos(dot) < 55°
on fait simplement : dot > cos(55°)
```

### Point important

La condition est stricte : `>` et pas `>=`.
Le bord exact du cône est donc exclu. C'est cohérent pour éviter les ambiguïtés de frontière.

### Conclusion

Ce calcul est correct.

---

<a name="calcul-3"></a>
## 3. Qualité du signal

Ici se trouvait le vrai bug.

### Formule d'origine

```python
quality = clamp(dot(sat_vec, dish_vec), 0.0, 1.0)
```

### Pourquoi c'est faux

Pour un satellite visible, on sait déjà que :

```text
dot >= cos(55°) ~ 0.5736
```

Donc avec cette formule, la qualité d'un satellite visible est toujours dans :

```text
[0.5736, 1.0]
```

Conséquence :

- le bord du FOV n'est jamais à `0`
- il n'apparaît jamais rouge
- la moitié basse de l'échelle de couleurs n'est jamais utilisée

### Exemple concret

| Position | Dot | Qualité d'origine | Qualité attendue |
|---|---:|---:|---:|
| Centre du faisceau | `1.0000` | `1.0000` | `1.0` |
| Bord du FOV | `0.5736` | `0.5736` | `0.0` |

Le problème est donc réel : la formule ne correspond pas à la sémantique voulue.

### Formule correcte

Il faut remapper la plage visible `[cos(55°), 1]` vers `[0, 1]` :

```python
COS_HALF = cos(radians(55))      # ~ 0.5736
RANGE    = 1.0 - COS_HALF        # ~ 0.4264

raw     = dot(sat_vec, dish_vec)
quality = clamp((raw - COS_HALF) / RANGE, 0.0, 1.0)
```

### Vérification

| Position | Raw | Qualité corrigée |
|---|---:|---:|
| Centre | `1.0000` | `1.0` |
| Bord | `0.5736` | `0.0` |
| Milieu de l'échelle | `0.7868` | `0.5` |

### Conclusion

La formule d'origine est fausse pour l'affichage et le scoring.

La bonne formule est :

```python
clamp((dot - cos55) / (1 - cos55), 0.0, 1.0)
```

---

<a name="calcul-4"></a>
## 4. SLERP pour l'animation des satellites

Interpoler directement l'azimut et l'élévation pose problème.

### Le cas classique qui casse tout

Un satellite passe de `350°` à `10°`.

Si on fait une interpolation naïve sur l'azimut :

```text
350 -> 180 -> 10
```

Visuellement, le satellite traverse presque tout le ciel à l'envers.

### Pourquoi la SLERP résout ça

Au lieu d'interpoler des angles, on interpole entre deux vecteurs 3D unitaires sur la sphère :

```javascript
function slerp(v0, v1, t) {
  const dot = Math.max(-1.0, Math.min(1.0, v0[0]*v1[0] + v0[1]*v1[1] + v0[2]*v1[2]));
  const theta = Math.acos(dot);
  if (Math.abs(theta) < 1e-6) return [...v0];

  const sinTheta = Math.sin(theta);
  const s0 = Math.sin((1 - t) * theta) / sinTheta;
  const s1 = Math.sin(t * theta) / sinTheta;

  return [
    s0 * v0[0] + s1 * v1[0],
    s0 * v0[1] + s1 * v1[1],
    s0 * v0[2] + s1 * v1[2],
  ];
}
```

### Ce que garantit la SLERP

- `t = 0` donne exactement `v0`
- `t = 1` donne exactement `v1`
- le mouvement suit le plus court chemin sur la sphère
- la norme reste égale à 1

### Cas limite

Le cas antipodal exact (`v1 = -v0`) est théoriquement délicat, mais sans importance ici : deux points d'un même segment FOV ne seront pas séparés de `180°`.

### Conclusion

La SLERP est la bonne méthode pour une animation stable, sans recul apparent ni téléportation.

---

<a name="calcul-5"></a>
## 5. Rendu du bord du cône FOV

On veut dessiner le cercle qui représente la frontière du cône sur la sphère unité.

### Base orthonormée autour de l'axe du dish

À partir de `dish_vec`, on construit deux vecteurs perpendiculaires `u` et `v` :

```javascript
function buildBasis(dish_vec) {
  const arbitrary = (Math.abs(dish_vec[1]) < 0.99)
    ? [0, 1, 0]
    : [1, 0, 0];

  const u = normalize(cross(dish_vec, arbitrary));
  const v = cross(dish_vec, u);
  return { u, v };
}
```

### Cercle de bord

```javascript
const COS_HALF = Math.cos(55 * Math.PI / 180);
const SIN_HALF = Math.sin(55 * Math.PI / 180);

for (let i = 0; i < N; i++) {
  const phi = 2 * Math.PI * i / N;
  const p = [
    COS_HALF * dish_vec[0] + SIN_HALF * (Math.cos(phi) * u[0] + Math.sin(phi) * v[0]),
    COS_HALF * dish_vec[1] + SIN_HALF * (Math.cos(phi) * u[1] + Math.sin(phi) * v[1]),
    COS_HALF * dish_vec[2] + SIN_HALF * (Math.cos(phi) * u[2] + Math.sin(phi) * v[2]),
  ];
  points.push(normalize(p));
}
```

### Pourquoi ce cercle est le bon

Deux propriétés importantes :

1. Chaque point reste sur la sphère unité.
2. Chaque point vérifie :

```text
dot(point, dish_vec) = cos(55°)
```

Autrement dit, le cercle dessiné côté frontend correspond exactement à la frontière utilisée côté backend pour filtrer les satellites.

### Conclusion

Le rendu du cône est correct si le repère 3D est identique partout.

---

<a name="calcul-6"></a>
## 6. Couleur en fonction de la qualité

Le shader suivant est correct :

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

### Lecture visuelle

- `q = 0.0` -> rouge
- `q = 0.5` -> jaune
- `q = 1.0` -> vert

La fonction est continue à `q = 0.5`, donc il n'y a pas de cassure visuelle au milieu.

### Important

Ce shader n'a de sens que si la qualité a été correctement remappée au calcul précédent.

Sinon :

- les satellites visibles restent entre jaune-vert et vert
- le rouge n'apparaît jamais

### Conclusion

Le shader est bon. Le vrai correctif se situe dans la formule de qualité, pas dans la palette.

---

<a name="calcul-7"></a>
## 7. Interpolation temporelle

Entre deux points de trajectoire, on calcule :

```javascript
const dt = p1.t - p0.t;
const alpha = (dt < 1e-9)
  ? 0.0
  : Math.min(1.0, Math.max(0.0, (t_now - p0.t) / dt));
```

Puis :

```javascript
const pos3d = slerp(
  azelToXYZ(p0.az, p0.el),
  azelToXYZ(p1.az, p1.el),
  alpha
);
```

### Pourquoi il faut ces gardes

- si `dt = 0`, on évite une division par zéro
- si `alpha < 0` ou `alpha > 1`, on évite une extrapolation hors segment

### Règles côté frontend

- ne jamais interpoler en dehors de `[t_entry, t_exit]`
- quand `t_now > t_exit`, il faut cacher le satellite
- ne jamais réutiliser une position provenant d'un ancien segment

### Conclusion

La formule est bonne, mais elle doit être encadrée par des gardes simples.

---

## Ce qui doit rester identique partout

Pour que l'ensemble soit physiquement cohérent, ces éléments doivent être partagés entre backend et frontend :

- même fonction `azelToXYZ`
- même repère `X = Est, Y = Haut, Z = Nord`
- même demi-angle `55°`
- même seuil `cos(55°)`
- même définition de la qualité remappée

Si un seul de ces éléments diverge, on verra apparaître des symptômes typiques :

- satellites visibles en dehors du cône
- cône FOV décalé par rapport à la carte d'obstruction
- trajectoires qui semblent "fausses"
- couleurs incohérentes

---

<a name="synthese"></a>
## Synthèse finale

| Sujet | Statut | À retenir |
|---|---|---|
| Conversion `az/el -> xyz` | Correct | La formule actuelle est bonne |
| Test FOV par produit scalaire | Correct | Mieux que `arccos`, plus simple et plus stable |
| Qualité du signal | À corriger | Il faut remapper `[cos55, 1]` vers `[0, 1]` |
| SLERP | Correct | Évite les sauts et les retours en arrière |
| Cercle de bord du cône | Correct | À condition d'utiliser le même repère partout |
| Shader couleur | Correct | Dépend du remapping correct de la qualité |
| Interpolation temporelle | Correct avec garde | Protéger `dt = 0` et limiter `alpha` |

---

## Formules finales à garder

### Conversion 3D

```python
x = cos(el) * sin(az)
y = sin(el)
z = cos(el) * cos(az)
```

### Filtre FOV

```python
visible = dot(sat_vec, dish_vec) > cos(radians(55))
```

### Qualité corrigée

```python
COS_HALF = cos(radians(55))
quality = clamp((dot - COS_HALF) / (1.0 - COS_HALF), 0.0, 1.0)
```

### Interpolation robuste

```javascript
const dt = p1.t - p0.t;
const alpha = (dt < 1e-9)
  ? 0.0
  : Math.min(1.0, Math.max(0.0, (t_now - p0.t) / dt));
```

### Règle générale

Le modèle est bon si on le traite comme un vrai problème 3D :

- directions sur sphère unité
- cône défini par angle avec l'axe du dish
- animation par SLERP
- qualité remappée sur la plage réellement visible

À partir de là, le backend, le frontend et le rendu visuel racontent enfin la même géométrie.
