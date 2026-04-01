#include <algorithm>
#include <cmath>
#include <cstdint>
#include <emscripten/emscripten.h>

namespace {

constexpr float kTau = 6.2831855f;

inline float clamp01(float value) {
  return std::max(0.0f, std::min(1.0f, value));
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void analyze_polygon(const float* points, int loops, int vertices_per_loop, float* result) {
  float total_area = 0.0f;
  float min_x = 1.0e9f;
  float min_y = 1.0e9f;
  float max_x = -1.0e9f;
  float max_y = -1.0e9f;

  for (int loop = 0; loop < loops; ++loop) {
    const float* base = points + (loop * vertices_per_loop * 2);
    float area = 0.0f;

    for (int vertex = 0; vertex < vertices_per_loop; ++vertex) {
      const int next = (vertex + 1) % vertices_per_loop;
      const float x1 = base[vertex * 2];
      const float y1 = base[vertex * 2 + 1];
      const float x2 = base[next * 2];
      const float y2 = base[next * 2 + 1];

      area += (x1 * y2) - (x2 * y1);

      min_x = std::min(min_x, x1);
      min_y = std::min(min_y, y1);
      max_x = std::max(max_x, x1);
      max_y = std::max(max_y, y1);
    }

    total_area += std::fabs(area) * 0.5f;
  }

  result[0] = total_area;
  result[1] = min_x;
  result[2] = min_y;
  result[3] = max_x;
  result[4] = max_y;
}

EMSCRIPTEN_KEEPALIVE
void analyze_heightfield(const float* values, int count, float* result) {
  float min_value = 1.0e9f;
  float max_value = -1.0e9f;
  float sum = 0.0f;

  for (int index = 0; index < count; ++index) {
    const float value = values[index];
    min_value = std::min(min_value, value);
    max_value = std::max(max_value, value);
    sum += value;
  }

  const float average = count > 0 ? (sum / static_cast<float>(count)) : 0.0f;

  result[0] = min_value;
  result[1] = max_value;
  result[2] = average;
  result[3] = sum;
}

EMSCRIPTEN_KEEPALIVE
void quantize_unit_f32(const float* values, int count, std::uint8_t* out, float* result) {
  float min_value = 1.0e9f;
  float max_value = -1.0e9f;
  float sum = 0.0f;
  float checksum = 0.0f;

  for (int index = 0; index < count; ++index) {
    const float value = values[index];
    min_value = std::min(min_value, value);
    max_value = std::max(max_value, value);
    sum += value;

    const auto quantized = static_cast<std::uint8_t>(clamp01(value) * 255.0f);
    out[index] = quantized;
    checksum += static_cast<float>(quantized);
  }

  const float average = count > 0 ? (sum / static_cast<float>(count)) : 0.0f;

  result[0] = min_value;
  result[1] = max_value;
  result[2] = average;
  result[3] = checksum;
}

EMSCRIPTEN_KEEPALIVE
void build_heightfield_mesh(
    const float* values,
    int width,
    int height,
    float* positions,
    std::uint32_t* indices,
    float* result) {
  const int vertex_count = width * height;
  const int triangle_count = std::max(width - 1, 0) * std::max(height - 1, 0) * 2;

  float min_value = 1.0e9f;
  float max_value = -1.0e9f;
  float sum = 0.0f;

  const float width_denominator = std::max(width - 1, 1);
  const float height_denominator = std::max(height - 1, 1);

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const int index = x + y * width;
      const float value = values[index];

      min_value = std::min(min_value, value);
      max_value = std::max(max_value, value);
      sum += value;

      const float fx = static_cast<float>(x) / width_denominator;
      const float fy = static_cast<float>(y) / height_denominator;
      const int position_offset = index * 3;

      positions[position_offset] = (fx * 8.4f) - 4.2f;
      positions[position_offset + 1] = value * 2.6f;
      positions[position_offset + 2] = (fy * 6.4f) - 3.2f;
    }
  }

  for (int y = 0; y < height - 1; ++y) {
    for (int x = 0; x < width - 1; ++x) {
      const std::uint32_t a = static_cast<std::uint32_t>(x + y * width);
      const std::uint32_t b = a + 1;
      const std::uint32_t c = a + static_cast<std::uint32_t>(width);
      const std::uint32_t d = c + 1;

      const float h00 = values[a];
      const float h10 = values[b];
      const float h01 = values[c];
      const float h11 = values[d];

      const float diag0 = std::fabs(h00 - h11);
      const float diag1 = std::fabs(h10 - h01);

      const int cell_offset = (x + y * (width - 1)) * 6;

      if (diag0 <= diag1) {
        indices[cell_offset] = a;
        indices[cell_offset + 1] = b;
        indices[cell_offset + 2] = d;
        indices[cell_offset + 3] = a;
        indices[cell_offset + 4] = d;
        indices[cell_offset + 5] = c;
      } else {
        indices[cell_offset] = a;
        indices[cell_offset + 1] = b;
        indices[cell_offset + 2] = c;
        indices[cell_offset + 3] = b;
        indices[cell_offset + 4] = d;
        indices[cell_offset + 5] = c;
      }
    }
  }

  const float average = vertex_count > 0 ? (sum / static_cast<float>(vertex_count)) : 0.0f;

  result[0] = static_cast<float>(vertex_count);
  result[1] = static_cast<float>(triangle_count);
  result[2] = min_value;
  result[3] = max_value;
  result[4] = average;
  result[5] = sum;
}

EMSCRIPTEN_KEEPALIVE
float step_rotation(float angle, float delta, float speed) {
  const float next = angle + (delta * speed);
  return next >= kTau ? (next - kTau) : next;
}

EMSCRIPTEN_KEEPALIVE
void update_swarm(float* state, int count, float* output, float delta, float time, int substeps) {
  if (substeps < 1) {
    substeps = 1;
  }

  const float sub_delta = delta / static_cast<float>(substeps);

  for (int index = 0; index < count; ++index) {
    float* entity = state + (index * 10);
    float home_x = entity[0];
    float home_y = entity[1];
    float home_z = entity[2];
    float pos_x = entity[3];
    float pos_y = entity[4];
    float pos_z = entity[5];
    float vel_x = entity[6];
    float vel_y = entity[7];
    float vel_z = entity[8];
    float phase = entity[9];

    for (int step = 0; step < substeps; ++step) {
      phase += sub_delta * (0.55f + (home_y * 0.015f));
      if (phase >= 1.0f) {
        phase -= 1.0f;
      }

      const float pulse = phase < 0.5f ? (phase * 2.0f) : ((1.0f - phase) * 2.0f);
      const float dx = home_x - pos_x;
      const float dy = home_y - pos_y;
      const float dz = home_z - pos_z;
      const float swirl_x = -dz * 0.48f;
      const float swirl_z = dx * 0.48f;
      const float lift = ((pulse - 0.5f) * 0.55f) + ((time + (home_x * 0.12f) + (home_z * 0.08f)) * 0.25f);

      vel_x =
          (vel_x * 0.94f) + (dx * 0.68f * sub_delta) + (swirl_x * 0.42f * sub_delta) +
          ((home_y + 0.3f) * 0.015f * sub_delta);
      vel_y = (vel_y * 0.92f) + (dy * 0.62f * sub_delta) + (lift * 0.38f * sub_delta);
      vel_z =
          (vel_z * 0.94f) + (dz * 0.68f * sub_delta) + (swirl_z * 0.42f * sub_delta) -
          ((home_x - home_z) * 0.01f * sub_delta);

      pos_x += vel_x * sub_delta;
      pos_y += vel_y * sub_delta;
      pos_z += vel_z * sub_delta;
    }

    entity[3] = pos_x;
    entity[4] = pos_y;
    entity[5] = pos_z;
    entity[6] = vel_x;
    entity[7] = vel_y;
    entity[8] = vel_z;
    entity[9] = phase;

    float* out = output + (index * 3);
    out[0] = pos_x;
    out[1] = pos_y;
    out[2] = pos_z;
  }
}

EMSCRIPTEN_KEEPALIVE
void simulate_swarm_frames(
    float* state,
    int count,
    float* output,
    float delta,
    float start_time,
    int substeps,
    int frames) {
  float time = start_time;

  for (int frame = 0; frame < frames; ++frame) {
    time += delta;
    update_swarm(state, count, output, delta, time, substeps);
  }
}

}
