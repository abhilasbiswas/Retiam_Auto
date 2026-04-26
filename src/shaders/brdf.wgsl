// =============================================================================
// brdf.wgsl — Principled BSDF evaluation module
// Concatenated into: raytracerClassic, raytracerReSTIR, radianceCascades, gbuffer
// All material scatter and evaluation logic lives here — zero duplication.
//
// Conventions:
//   alpha = roughness^2  (perceptual roughness remapping, standard in Filament/UE4)
//   F0    = base reflectance at normal incidence
//   L     = direction TOWARD light (or next bounce direction)
//   V     = direction TOWARD viewer (away from surface)
//   H     = half-vector = normalize(L + V)
// =============================================================================

const BRDF_PI     : f32 = 3.14159265359;
const BRDF_INV_PI : f32 = 0.31830988618;

// -----------------------------------------------------------------------------
// Fresnel — Schlick approximation
// F0: base reflectance at normal incidence
// cos_theta: should be dot(V, H) for specular, dot(V, N) for env approximation
// -----------------------------------------------------------------------------
fn fresnel_schlick(cos_theta: f32, F0: vec3<f32>) -> vec3<f32> {
    let f = clamp(1.0 - cos_theta, 0.0, 1.0);
    let f2 = f * f;
    return F0 + (vec3<f32>(1.0) - F0) * (f2 * f2 * f);
}

// Scalar Schlick — used for glass Fresnel probability
fn fresnel_schlick_scalar(cos_theta: f32, F0: f32) -> f32 {
    let f = clamp(1.0 - cos_theta, 0.0, 1.0);
    let f2 = f * f;
    return F0 + (1.0 - F0) * (f2 * f2 * f);
}

// F0 from IOR using the standard Fresnel formula
// specular: 0.5 = Blender/physical default → F0 = 0.04 for IOR=1.5
// The formula is: F0 = ((n-1)/(n+1))^2 * specular_scale
// where specular_scale maps 0.5→1.0 (i.e., default specular=0.5 means no attenuation of standard F0)
fn F0_from_ior(ior: f32, specular: f32) -> f32 {
    let r0_raw = (1.0 - ior) / (1.0 + ior);
    // specular remapping: 0.5 = standard 4% reflectance for glass (IOR=1.5)
    // Blender defines specular such that specular=0.5 gives the physical IOR-derived F0 unchanged
    return clamp(r0_raw * r0_raw * specular * 2.0, 0.0, 1.0);
}

// -----------------------------------------------------------------------------
// GGX Normal Distribution Function (Trowbridge-Reitz)
// alpha = roughness^2  (perceptual roughness squared)
// Returns the NDF value D(H)
// -----------------------------------------------------------------------------
fn D_GGX(NdotH: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / max(BRDF_PI * d * d, 0.000001);
}

// -----------------------------------------------------------------------------
// Smith Masking-Shadowing (Height-Correlated, Heitz 2014)
// Returns the COMBINED visibility term V(L,V,H) = G(L,V,H) / (4*NdotL*NdotV)
// This form is pre-divided so specular = D * V * F directly
// -----------------------------------------------------------------------------
fn V_SmithGGX(NdotL: f32, NdotV: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    // λ for V direction
    let ggxV = NdotL * sqrt(max(NdotV * NdotV * (1.0 - a2) + a2, 0.0));
    // λ for L direction
    let ggxL = NdotV * sqrt(max(NdotL * NdotL * (1.0 - a2) + a2, 0.0));
    return 0.5 / max(ggxV + ggxL, 0.000001);
}

// -----------------------------------------------------------------------------
// GGX Importance Sampling — sample a half-vector H from the GGX distribution
// alpha = roughness^2 (same convention as D_GGX and V_SmithGGX)
// Returns world-space H
// -----------------------------------------------------------------------------
fn sample_GGX_halfvector(N: vec3<f32>, alpha: f32, rng: ptr<function, u32>) -> vec3<f32> {
    let u1 = rand_float(rng);
    let u2 = rand_float(rng);

    // Spherical coords of H in tangent space
    let phi       = 2.0 * BRDF_PI * u1;
    // cos(theta_h) from GGX PDF: p(theta) = a^2 * cos(theta)*sin(theta) / (pi*(cos^2*(a^2-1)+1)^2)
    let cos_theta = sqrt(max(0.0, (1.0 - u2) / max(1.0 + (alpha * alpha - 1.0) * u2, 0.000001)));
    let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));

    // Build TBN frame
    let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(N.y) < 0.99);
    let T  = normalize(cross(up, N));
    let B  = cross(N, T);
    return normalize(T * (sin_theta * cos(phi))
                   + B * (sin_theta * sin(phi))
                   + N *  cos_theta);
}

// -----------------------------------------------------------------------------
// Compute F0 (base reflectance at normal incidence)
// Dielectrics: derived from IOR and Blender-style specular level
// Conductors (metals): use albedo as F0 (chromatic reflectance)
// -----------------------------------------------------------------------------
fn compute_F0(mat: Material) -> vec3<f32> {
    let f0_dielectric = F0_from_ior(mat.ior, mat.specular);
    return mix(vec3<f32>(f0_dielectric), mat.color, mat.metallic);
}

// =============================================================================
// BSDF SCATTER — Opaque Surface
// Importance-samples a new ray direction using MIS between diffuse and specular.
// Returns throughput multiplier for the chosen path.
// =============================================================================
fn bsdf_scatter_opaque(
    ray: ptr<function, Ray>,
    hit: HitRecord,
    rng: ptr<function, u32>
) -> vec3<f32> {
    let N     = hit.normal;
    let V     = -(*ray).dir;             // view direction (away from surface)
    let NdotV = max(dot(N, V), 0.0001);

    // alpha = roughness^2 (perceptual remapping — industry standard)
    let alpha = max(hit.mat.roughness * hit.mat.roughness, 0.001);

    let F0 = compute_F0(hit.mat);

    // Approximate Fresnel at view angle for path selection probability
    // Use NdotV as a conservative estimate (actual is VdotH, computed below)
    let F_view    = fresnel_schlick(NdotV, F0);
    let p_spec    = clamp(dot(F_view, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.01, 0.99);

    var throughput = vec3<f32>(1.0);
    var new_dir    = vec3<f32>(0.0);

    if (rand_float(rng) < p_spec) {
        // --- SPECULAR PATH: GGX importance-sampled half-vector ---
        let H   = sample_GGX_halfvector(N, alpha, rng);
        new_dir = reflect(-V, H);

        if (dot(new_dir, N) <= 0.0) {
            // Degenerate: H pointed below surface, fall back to mirror
            new_dir = reflect(-V, N);
        }

        let NdotL = max(dot(N, new_dir), 0.0001);
        let NdotH = max(dot(N, H),       0.0001);
        let VdotH = max(dot(V, H),        0.0001);

        // Fresnel evaluated at the CORRECT angle (VdotH, not NdotV)
        let F_spec = fresnel_schlick(VdotH, F0);

        // GGX IS weight derivation:
        //   BRDF:  f(L,V) = D * F * G4   (G4 = G / (4·NdotL·NdotV) = V_SmithGGX)
        //   PDF:   p(L)   = D * NdotH / (4 * VdotH)
        //   weight = f * NdotL / p(L)
        //         = D*F*G4*NdotL * 4*VdotH / (D*NdotH)
        //         = F * G4 * 4 * VdotH * NdotL / NdotH
        let G4     = V_SmithGGX(NdotL, NdotV, alpha);
        let weight = F_spec * G4 * (4.0 * VdotH * NdotL / NdotH);
        throughput = weight / p_spec;

    } else {
        // --- DIFFUSE PATH: cosine-weighted hemisphere ---
        new_dir = normalize(N + rand_unit_vector(rng));

        // kD: energy not captured by specular, zero for metals
        // F at view angle is a reasonable approximation for hemisphere integral of F
        let kD = (vec3<f32>(1.0) - F_view) * (1.0 - hit.mat.metallic);

        // Cosine-weighted sampling cancels the NdotL/pi in the BRDF:
        //   f_diff = color/pi, PDF = NdotL/pi => weight = color
        // Multiply by kD for energy conservation, divide by (1-p_spec) for path selection MIS
        throughput = hit.mat.color * kD / (1.0 - p_spec);
    }

    (*ray).dir     = normalize(new_dir);
    // Robust self-intersection avoidance: offset along normal, and push forward along outgoing ray
    (*ray).origin  = hit.point + N * 0.001 + (*ray).dir * 0.002;
    (*ray).invDir  = 1.0 / (*ray).dir;
    return max(throughput, vec3<f32>(0.0));
}

// =============================================================================
// BSDF SCATTER — Transmission (Glass / Dielectric)
// Physically-correct Schlick Fresnel determines reflection vs refraction.
// =============================================================================
fn bsdf_scatter_transmit(
    ray: ptr<function, Ray>,
    hit: HitRecord,
    rng: ptr<function, u32>
) -> vec3<f32> {
    let entering  = dot((*ray).dir, hit.normal) < 0.0;
    let N         = select(-hit.normal, hit.normal, entering);
    let eta       = select(hit.mat.ior, 1.0 / hit.mat.ior, entering);

    let cos_theta = min(dot(-(*ray).dir, N), 1.0);
    let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));

    // IOR-derived F0 (no specular scaling for glass — pure physical)
    let r0_raw = (1.0 - hit.mat.ior) / (1.0 + hit.mat.ior);
    let F0     = r0_raw * r0_raw;
    let F      = fresnel_schlick_scalar(cos_theta, F0);

    var new_dir: vec3<f32>;
    var is_external_reflection = false;

    if (eta * sin_theta > 1.0 || rand_float(rng) < F) {
        // Total internal reflection OR Fresnel reflection
        new_dir = reflect((*ray).dir, N);
        (*ray).dir    = normalize(new_dir);
        (*ray).origin = hit.point + N * 0.001 + (*ray).dir * 0.002;
        is_external_reflection = entering;
    } else {
        // Snell's law refraction
        new_dir = refract(normalize((*ray).dir), N, eta);
        (*ray).dir    = normalize(new_dir);
        (*ray).origin = hit.point - N * 0.001 + (*ray).dir * 0.002;
    }

    (*ray).invDir = 1.0 / (*ray).dir;
    
    if (is_external_reflection) {
        return vec3<f32>(1.0); // External reflections off glass are physically un-tinted
    }
    return hit.mat.color; // Beer-Lambert tint per bounce through the volume
}

// =============================================================================
// BSDF SCATTER — Combined Entry Point
// Handles opacity cutout, then routes to transmission or opaque lobe.
// Returns false if throughput is negligible (ray absorbed).
// =============================================================================
fn bsdf_scatter(
    ray:        ptr<function, Ray>,
    hit:        HitRecord,
    rng:        ptr<function, u32>,
    throughput: ptr<function, vec3<f32>>
) -> bool {
    // NOTE: Opacity is handled at the intersection level in worldHit().
    // Do NOT check it here — that would double-apply the opacity filter.

    if (rand_float(rng) < hit.mat.transmission) {
        (*throughput) *= bsdf_scatter_transmit(ray, hit, rng);
    } else {
        (*throughput) *= bsdf_scatter_opaque(ray, hit, rng);
    }

    return max((*throughput).r, max((*throughput).g, (*throughput).b)) > 0.001;
}

// =============================================================================
// BSDF EVAL — Evaluate BSDF for a KNOWN direction pair (no sampling)
// Used by: ReSTIR reservoir weighting, Radiance Cascade resolve passes.
// L: light direction (toward surface from light, but we use it as incoming)
// V: view direction (away from surface toward camera)
// Returns: f(L,V) * NdotL  (ready to multiply by incoming radiance)
// =============================================================================
fn eval_bsdf(
    L:   vec3<f32>,
    V:   vec3<f32>,
    N:   vec3<f32>,
    mat: Material
) -> vec3<f32> {
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 0.0001);
    if (NdotL <= 0.0) { return vec3<f32>(0.0); }

    let H     = normalize(V + L);
    let NdotH = max(dot(N, H), 0.0001);
    let VdotH = max(dot(V, H), 0.0001);

    // alpha = roughness^2 (perceptual remapping)
    let alpha = max(mat.roughness * mat.roughness, 0.001);

    let F0 = compute_F0(mat);
    let F  = fresnel_schlick(VdotH, F0);         // correct angle: VdotH

    let D  = D_GGX(NdotH, alpha);                // NDF
    let G4 = V_SmithGGX(NdotL, NdotV, alpha);   // combined visibility (G/4NdotLNdotV)

    // Cook-Torrance: f_spec = D * F * G / (4 * NdotL * NdotV) = D * F * G4
    let f_specular = D * F * G4;

    // Lambertian diffuse: f_diff = (1-F)*(1-metallic)*albedo/pi
    let kD      = (vec3<f32>(1.0) - F) * (1.0 - mat.metallic);
    let f_diffuse = kD * mat.color * BRDF_INV_PI;

    return (f_diffuse + f_specular) * NdotL;
}
