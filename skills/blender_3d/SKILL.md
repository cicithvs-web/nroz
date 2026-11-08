---
name: blender_3d
description: Panduan pembuatan gambar & video 3D photorealistic menggunakan Blender headless (Python bpy) di Docker sandbox. Untuk rendering raytracing, material kaca/logam/air, pencahayaan studio sinematik.
---

# Panduan Keahlian: Rendering 3D Photorealistic dengan Blender Headless

Skill ini digunakan saat user meminta **gambar/video 3D kualitas tinggi (photorealistic)** yang membutuhkan:
- Pencahayaan fisik nyata (ray-tracing, global illumination, caustics)
- Material realistis (kaca transparan, air, logam reflektif, kulit, kain)
- Bayangan lembut alami, depth of field, motion blur
- Kualitas setara render studio arsitektur / iklan TV / visual efek film

## 🔧 Tools yang Digunakan

- **`run_code`** — Untuk menjalankan script Python Blender di sandbox Docker
- **`send_photo`** — Untuk mengirim hasil render gambar ke Telegram
- **`send_file`** — Untuk mengirim hasil render video ke Telegram

## ⚠️ Aturan Alur Kerja Wajib

### Untuk Gambar (Still Image) — 3 Langkah:
1. **Tulis script Python** yang menggunakan modul `bpy` (Blender Python API)
2. **Jalankan via `run_code`** dengan bahasa `python3`:
   ```
   blender -b -P /workspace/artifacts/render_scene.py 2>&1
   ```
   Atau lebih baik via `run_command`:
   ```
   blender -b -P /workspace/artifacts/render_scene.py -- --cycles-device CPU 2>&1
   ```
3. **WAJIB panggil `send_photo`** setelah file gambar tercipta

### Untuk Video (Animasi) — 4 Langkah:
1. **Tulis script Python** dengan keyframe animasi
2. **Jalankan render semua frame** via `run_command` (background jika lama):
   ```
   blender -b -P /workspace/artifacts/render_anim.py -o /workspace/artifacts/frame_#### -a -F PNG 2>&1
   ```
3. **Gabungkan frame jadi video** dengan ffmpeg:
   ```
   ffmpeg -framerate 30 -i /workspace/artifacts/frame_%04d.png -c:v libx264 -pix_fmt yuv420p /workspace/artifacts/output.mp4
   ```
4. **Kirim video** via `send_file`

## 📐 Template Dasar: Render Gambar 3D

```python
import bpy
import math

# ═══════════════════════════════════════════════════════════════
# 1. BERSIHKAN SCENE
# ═══════════════════════════════════════════════════════════════
bpy.ops.wm.read_factory_settings(use_empty=True)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 128          # Kualitas (64=draft, 128=bagus, 256=premium)
scene.cycles.use_denoising = True   # Noise reduction otomatis

# Resolusi output
scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = '/workspace/artifacts/render_3d.png'

# ═══════════════════════════════════════════════════════════════
# 2. KAMERA
# ═══════════════════════════════════════════════════════════════
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 50                     # 50mm lens (standar portrait)
cam_data.dof.use_dof = True            # Depth of Field (bokeh)
cam_data.dof.aperture_fstop = 2.8      # Bukaan lensa (makin kecil = makin blur background)

cam_obj = bpy.data.objects.new("Camera", cam_data)
bpy.context.collection.objects.link(cam_obj)
scene.camera = cam_obj
cam_obj.location = (4, -4, 3)
cam_obj.rotation_euler = (math.radians(65), 0, math.radians(45))

# ═══════════════════════════════════════════════════════════════
# 3. PENCAHAYAAN STUDIO (3-Point Lighting)
# ═══════════════════════════════════════════════════════════════
# Key Light
key_data = bpy.data.lights.new("KeyLight", type='AREA')
key_data.energy = 500
key_data.size = 3
key_obj = bpy.data.objects.new("KeyLight", key_data)
bpy.context.collection.objects.link(key_obj)
key_obj.location = (4, -2, 5)
key_obj.rotation_euler = (math.radians(60), 0, math.radians(30))

# Fill Light
fill_data = bpy.data.lights.new("FillLight", type='AREA')
fill_data.energy = 200
fill_data.size = 4
fill_data.color = (0.8, 0.9, 1.0)  # Sedikit biru
fill_obj = bpy.data.objects.new("FillLight", fill_data)
bpy.context.collection.objects.link(fill_obj)
fill_obj.location = (-3, -3, 3)

# Rim Light
rim_data = bpy.data.lights.new("RimLight", type='POINT')
rim_data.energy = 300
rim_data.color = (1.0, 0.9, 0.7)  # Warm
rim_obj = bpy.data.objects.new("RimLight", rim_data)
bpy.context.collection.objects.link(rim_obj)
rim_obj.location = (0, 4, 4)

# ═══════════════════════════════════════════════════════════════
# 4. OBJEK 3D + MATERIAL
# ═══════════════════════════════════════════════════════════════
# Torus Knot (objek utama)
bpy.ops.mesh.primitive_torus_add(
    major_radius=1.2,
    minor_radius=0.4,
    major_segments=64,
    minor_segments=24,
    location=(0, 0, 1)
)
obj = bpy.context.active_object
obj.name = "MainObject"

# Smooth shading
bpy.ops.object.shade_smooth()

# Material: Logam Emas
mat = bpy.data.materials.new("GoldMetal")
mat.use_nodes = True
nodes = mat.node_tree.nodes
principled = nodes.get("Principled BSDF")
principled.inputs["Base Color"].default_value = (1.0, 0.76, 0.33, 1.0)
principled.inputs["Metallic"].default_value = 1.0
principled.inputs["Roughness"].default_value = 0.1
obj.data.materials.append(mat)

# Lantai
bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
floor = bpy.context.active_object
floor_mat = bpy.data.materials.new("FloorMat")
floor_mat.use_nodes = True
floor_nodes = floor_mat.node_tree.nodes
floor_principled = floor_nodes.get("Principled BSDF")
floor_principled.inputs["Base Color"].default_value = (0.05, 0.05, 0.08, 1.0)
floor_principled.inputs["Metallic"].default_value = 0.8
floor_principled.inputs["Roughness"].default_value = 0.2
floor.data.materials.append(floor_mat)

# ═══════════════════════════════════════════════════════════════
# 5. WORLD BACKGROUND (HDRI-style gradient)
# ═══════════════════════════════════════════════════════════════
world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = (0.01, 0.01, 0.02, 1.0)
bg.inputs["Strength"].default_value = 0.5

# ═══════════════════════════════════════════════════════════════
# 6. RENDER!
# ═══════════════════════════════════════════════════════════════
bpy.ops.render.render(write_still=True)
print(f"✅ Render selesai: {scene.render.filepath}")
```

## 🎨 Resep Material Umum

### Logam (Emas, Chrome, Tembaga)
```python
principled.inputs["Base Color"].default_value = (1.0, 0.76, 0.33, 1.0)  # Emas
# principled.inputs["Base Color"].default_value = (0.9, 0.9, 0.95, 1.0)  # Chrome
# principled.inputs["Base Color"].default_value = (0.72, 0.45, 0.2, 1.0)  # Tembaga
principled.inputs["Metallic"].default_value = 1.0
principled.inputs["Roughness"].default_value = 0.1  # 0.0 = mirror, 0.3 = brushed
```

### Kaca Transparan
```python
principled.inputs["Base Color"].default_value = (0.95, 0.95, 1.0, 1.0)
principled.inputs["Metallic"].default_value = 0.0
principled.inputs["Roughness"].default_value = 0.0
principled.inputs["Transmission Weight"].default_value = 1.0  # Blender 4.x
principled.inputs["IOR"].default_value = 1.45  # Indeks bias kaca
```

### Plastik Glossy
```python
principled.inputs["Base Color"].default_value = (0.8, 0.1, 0.1, 1.0)  # Merah
principled.inputs["Metallic"].default_value = 0.0
principled.inputs["Roughness"].default_value = 0.3
principled.inputs["Coat Weight"].default_value = 0.5       # Clear coat
principled.inputs["Coat Roughness"].default_value = 0.1
```

### Emissive / Neon / LED
```python
principled.inputs["Base Color"].default_value = (0, 1, 0.5, 1.0)
principled.inputs["Emission Color"].default_value = (0, 1, 0.5, 1.0)
principled.inputs["Emission Strength"].default_value = 10.0
```

### Marble / Batu (dengan Noise Texture)
```python
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
principled = nodes.get("Principled BSDF")

noise = nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 5.0
noise.inputs["Detail"].default_value = 8.0

ramp = nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.9, 0.88, 0.85, 1.0)  # Putih
ramp.color_ramp.elements[1].color = (0.2, 0.18, 0.15, 1.0)   # Urat gelap

links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
links.new(ramp.outputs["Color"], principled.inputs["Base Color"])
principled.inputs["Roughness"].default_value = 0.3
```

## 🎬 Template Animasi Video

```python
import bpy
import math

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ── Render settings ──
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 64  # Lebih rendah untuk video (banyak frame)
scene.cycles.use_denoising = True
scene.render.resolution_x = 1080
scene.render.resolution_y = 1920  # Portrait (Reels/Shorts)
scene.render.fps = 30
scene.frame_start = 1
scene.frame_end = 90  # 3 detik @ 30fps
scene.render.filepath = '/workspace/artifacts/frame_'
scene.render.image_settings.file_format = 'PNG'

# ── Scene setup (kamera, lampu, objek) ──
# ... (sama seperti template gambar di atas) ...

# ── KEYFRAME ANIMASI ──
obj = bpy.data.objects["MainObject"]

# Frame 1: posisi awal
obj.rotation_euler = (0, 0, 0)
obj.keyframe_insert(data_path="rotation_euler", frame=1)

# Frame 90: rotasi penuh 360°
obj.rotation_euler = (0, 0, math.radians(360))
obj.keyframe_insert(data_path="rotation_euler", frame=90)

# Smooth interpolation
for fcurve in obj.animation_data.action.fcurves:
    for kp in fcurve.keyframe_points:
        kp.interpolation = 'BEZIER'
        kp.easing = 'AUTO'

# ── Render semua frame ──
bpy.ops.render.render(animation=True)
print("✅ Animasi selesai dirender!")
```

Setelah frame dirender, gabungkan jadi video:
```bash
ffmpeg -framerate 30 -i /workspace/artifacts/frame_%04d.png \
  -c:v libx264 -pix_fmt yuv420p -crf 18 \
  /workspace/artifacts/video_3d.mp4
```

## ⚡ Tips Performa

| Setting | Draft (Cepat) | Final (Bagus) | Premium (Lambat) |
|---------|--------------|---------------|------------------|
| `cycles.samples` | 32 | 128 | 256+ |
| Resolution | 960x540 | 1920x1080 | 3840x2160 |
| `use_denoising` | True | True | True |
| FPS (video) | 24 | 30 | 30 |

- **Untuk gambar tunggal**: Gunakan 128–256 samples (render 10–30 detik)
- **Untuk video**: Gunakan 32–64 samples + denoising (render per frame 3–8 detik)
- **Selalu aktifkan denoising** (`scene.cycles.use_denoising = True`) — mengurangi noise drastis bahkan dengan sample rendah

## 🔑 Catatan Penting

1. **Blender dijalankan di Docker sandbox** — Gunakan `run_command` bukan `run_code` agar timeout lebih panjang (terutama untuk video)
2. **Untuk render video yang lama**, jalankan sebagai background command:
   ```json
   { "command": "blender -b -P /workspace/artifacts/render.py -a 2>&1", "background": true }
   ```
3. **Output file HARUS di `/workspace/artifacts/`** agar bisa diakses oleh `send_photo` / `send_file`
4. **Resolusi portrait (1080x1920)** untuk konten Reels/TikTok/Shorts
5. **Resolusi landscape (1920x1080)** untuk konten YouTube/presentasi
6. **Jangan lupa install ffmpeg di sandbox** jika belum ada: `apt-get install -y ffmpeg`

## 🔄 Hybrid Pipeline: Blender + Remotion

Untuk video dengan narasi dan subtitle:
1. Render scene 3D di Blender → output video `.mp4` tanpa audio
2. Gunakan video tersebut sebagai background di Remotion via `staticFile()`
3. Remotion menambahkan overlay teks, subtitle, transisi, dan TTS narasi
4. Hasil akhir: video 3D profesional lengkap dengan voice-over!
