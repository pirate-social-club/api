from __future__ import annotations

import numpy as np

from .features import FeatureSequence


def canonical_fingerprint_material(features: FeatureSequence) -> bytes:
    """Return bounded canonical material; the API must apply the platform-held HMAC."""
    energy = np.linalg.norm(np.nan_to_num(features.velocity, nan=0.0), axis=2)
    buckets = np.mean(energy, axis=1)
    if len(buckets) > 64:
        boundaries = np.linspace(0, len(buckets), 65, dtype=int)
        buckets = np.asarray(
            [np.mean(buckets[boundaries[index] : boundaries[index + 1]]) for index in range(64)]
        )
    scale = float(np.percentile(buckets, 90)) if len(buckets) else 0.0
    normalized = buckets / max(scale, 1e-8)
    quantized = np.clip(np.rint(normalized * 31), 0, 255).astype(np.uint8)
    return bytes(quantized)
