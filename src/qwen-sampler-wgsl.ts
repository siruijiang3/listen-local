// Exact top-50 categorical sampling for the 2048 residual codec logits.
// A fixed bitonic sort also preserves the JavaScript sampler's index tie break.
export const residualSampler = `
struct Params { random: f32, group: u32, next_base: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> packed: array<u32>;
@group(0) @binding(1) var<storage, read_write> result: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> next_id: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;
var<workgroup> scores: array<f32, 2048>;
var<workgroup> ids: array<u32, 2048>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local: vec3<u32>) {
  for(var i = local.x; i < 2048u; i += 256u) {
    let pair = unpack2x16float(packed[i / 2u]);
    var value = select(pair.x, pair.y, (i & 1u) == 1u);
    if (!(value == value) || abs(value) > 65504.0) {
      atomicStore(&result[16], 1u); value = -1e30;
    }
    scores[i] = value; ids[i] = i;
  }
  workgroupBarrier();
  for(var width = 2u; width <= 2048u; width *= 2u) {
    for(var stride = width / 2u; stride > 0u; stride /= 2u) {
      for(var i = local.x; i < 2048u; i += 256u) {
        let j = i ^ stride;
        if (j > i) {
          let better = scores[i] > scores[j] || (scores[i] == scores[j] && ids[i] < ids[j]);
          let descending = (i & width) == 0u;
          if (better != descending) {
            let value = scores[i]; scores[i] = scores[j]; scores[j] = value;
            let id = ids[i]; ids[i] = ids[j]; ids[j] = id;
          }
        }
      }
      workgroupBarrier();
    }
  }
  if (local.x == 0u) {
    var total = 0.0;
    for(var i = 0u; i < 50u; i++) { total += exp((scores[i] - scores[0]) / 0.9); }
    var remaining = params.random * total;
    var chosen = ids[49];
    for(var i = 0u; i < 50u; i++) {
      remaining -= exp((scores[i] - scores[0]) / 0.9);
      if (remaining <= 0.0) { chosen = ids[i]; break; }
    }
    atomicStore(&result[params.group], chosen);
    next_id[0] = params.next_base + chosen;
  }
}
`;
