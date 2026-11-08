---
name: threejs_3d
description: Panduan pembuatan video 3D menggunakan Three.js / React Three Fiber di dalam Remotion. Untuk animasi 3D modern, motion graphics produk, visualisasi data 3D, dan teks 3D.
---

# Panduan Keahlian: Video 3D dengan Three.js di Remotion

Skill ini digunakan saat user meminta **video 3D**, animasi produk berputar, teks 3D, visualisasi data 3D, objek geometri futuristik, atau motion graphics bergaya modern/Apple-style.

## 🔧 Library yang Tersedia

Semua sudah terinstall di `remotion-engine/node_modules/`:
- `three` — Core Three.js (geometri, material, cahaya, kamera)
- `@react-three/fiber` — React renderer untuk Three.js (`<Canvas>`)
- `@react-three/drei` — Helper components (OrbitControls, Text3D, Environment, Float, MeshTransmission, dll.)
- `@remotion/three` — Integrasi Remotion + Three.js (`<ThreeCanvas>`)

## ⚠️ Aturan Wajib

1. **GUNAKAN `render_remotion_video` tool** — Sama seperti video Remotion biasa. Tulis kode React/TSX yang menggunakan Three.js, lalu render via tool `render_remotion_video`.
2. **GUNAKAN `<ThreeCanvas>` dari `@remotion/three`** — JANGAN gunakan `<Canvas>` dari `@react-three/fiber` secara langsung. `<ThreeCanvas>` milik Remotion sudah menangani sinkronisasi frame rendering.
3. **Animasi HARUS berbasis `useCurrentFrame()`** — Jangan gunakan `useFrame()` dari R3F. Gunakan `useCurrentFrame()` dari `remotion` untuk menghitung posisi, rotasi, skala setiap frame.

## 📐 Template Dasar (Wajib Ikuti Struktur Ini)

```tsx
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import React, { useRef } from "react";
import * as THREE from "three";

export default function MyScene() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Animasi: rotasi objek 360 derajat selama durasi video
  const rotationY = interpolate(frame, [0, 150], [0, Math.PI * 2]);

  // Animasi: zoom kamera masuk
  const cameraZ = interpolate(frame, [0, 60], [8, 4], {
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ width: "100%", height: "100%", backgroundColor: "#0a0a0a" }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ position: [0, 2, cameraZ], fov: 50 }}
      >
        {/* Pencahayaan Studio */}
        <ambientLight intensity={0.3} />
        <directionalLight position={[5, 10, 5]} intensity={1.5} castShadow />
        <pointLight position={[-5, 5, -5]} intensity={0.8} color="#4488ff" />

        {/* Objek 3D */}
        <mesh rotation={[0.3, rotationY, 0]} castShadow>
          <torusKnotGeometry args={[1, 0.35, 128, 32]} />
          <meshStandardMaterial
            color="#ff6600"
            metalness={0.9}
            roughness={0.15}
          />
        </mesh>

        {/* Lantai reflektif */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]} receiveShadow>
          <planeGeometry args={[20, 20]} />
          <meshStandardMaterial color="#111111" metalness={0.8} roughness={0.3} />
        </mesh>
      </ThreeCanvas>
    </div>
  );
}
```

## 🎨 Resep Visual Umum

### Material PBR (Physically Based Rendering)
```tsx
// Logam mengkilap (emas, chrome, tembaga)
<meshStandardMaterial color="#ffd700" metalness={1.0} roughness={0.1} />

// Kaca / kristal transparan
<meshPhysicalMaterial
  color="#ffffff"
  metalness={0.0}
  roughness={0.0}
  transmission={0.95}
  thickness={1.5}
  ior={1.5}
/>

// Plastik matte
<meshStandardMaterial color="#ff4444" metalness={0.0} roughness={0.7} />

// Emissive / neon glow
<meshStandardMaterial color="#00ffaa" emissive="#00ffaa" emissiveIntensity={2} />
```

### Pencahayaan Sinematik (3-Point Lighting)
```tsx
{/* Key light — cahaya utama */}
<directionalLight position={[5, 8, 5]} intensity={1.5} castShadow />
{/* Fill light — mengisi bayangan */}
<pointLight position={[-4, 3, -3]} intensity={0.6} color="#6699ff" />
{/* Rim/Back light — silhouette */}
<pointLight position={[0, 5, -8]} intensity={0.8} color="#ff9944" />
{/* Ambient — cahaya dasar */}
<ambientLight intensity={0.15} />
```

### Animasi Kamera Sinematik
```tsx
const frame = useCurrentFrame();
const { fps } = useVideoConfig();

// Orbit kamera mengelilingi objek
const angle = interpolate(frame, [0, 150], [0, Math.PI * 2]);
const cameraX = Math.sin(angle) * 5;
const cameraZ = Math.cos(angle) * 5;
const cameraY = interpolate(frame, [0, 150], [3, 1.5]);

<ThreeCanvas camera={{ position: [cameraX, cameraY, cameraZ], fov: 45 }}>
```

### Teks 3D (dari @react-three/drei)
```tsx
import { Text3D, Center } from "@react-three/drei";
// CATATAN: Text3D membutuhkan font JSON. Gunakan Text biasa jika tidak ada font file:
import { Text } from "@react-three/drei";

<Text
  position={[0, 2, 0]}
  fontSize={1.5}
  color="#ffffff"
  anchorX="center"
  anchorY="middle"
  font="https://fonts.gstatic.com/s/inter/v18/UcCo3FwrK3iLTcviYwY.woff"
>
  Hello 3D World
</Text>
```

### Geometri Bawaan Three.js
```tsx
<boxGeometry args={[1, 1, 1]} />           // Kubus
<sphereGeometry args={[1, 32, 32]} />       // Bola
<cylinderGeometry args={[0.5, 0.5, 2]} />   // Silinder
<torusGeometry args={[1, 0.4, 16, 100]} />  // Donat
<torusKnotGeometry args={[1, 0.3, 100, 16]} /> // Simpul torus
<coneGeometry args={[1, 2, 32]} />           // Kerucut
<dodecahedronGeometry args={[1]} />          // Dodekahedron
<icosahedronGeometry args={[1]} />           // Ikosahedron
<planeGeometry args={[10, 10]} />            // Bidang datar
```

### Memuat Model 3D (.glb/.gltf)
```tsx
// User perlu upload file .glb ke workspace, lalu copy ke remotion-engine/public/
// Gunakan staticFile() untuk referensi
import { useGLTF } from "@react-three/drei";

function Model({ rotation }) {
  const { scene } = useGLTF(staticFile("model.glb"));
  return <primitive object={scene} rotation={rotation} scale={1.5} />;
}
```

## 🎬 Contoh Penggunaan Lengkap: Animasi Produk Smartphone

```tsx
import { useCurrentFrame, useVideoConfig, interpolate, spring, staticFile } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import React from "react";

export default function ProductShowcase() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Intro: muncul dari bawah
  const posY = spring({ frame, fps, config: { damping: 15 }, from: -3, to: 0 });

  // Rotasi perlahan
  const rotY = interpolate(frame, [0, 300], [0, Math.PI * 2]);

  // Cahaya bergerak
  const lightX = Math.sin(frame * 0.03) * 5;

  return (
    <div style={{ width: "100%", height: "100%", background: "linear-gradient(180deg, #0a0a2e 0%, #1a1a3e 100%)" }}>
      <ThreeCanvas width={width} height={height} camera={{ position: [0, 1, 5], fov: 40 }}>
        <ambientLight intensity={0.2} />
        <spotLight position={[lightX, 8, 5]} intensity={2} angle={0.4} penumbra={0.5} castShadow />
        <pointLight position={[-3, 2, -3]} intensity={0.5} color="#4466ff" />

        {/* Smartphone body (simplified box) */}
        <group position={[0, posY, 0]} rotation={[0.1, rotY, 0]}>
          <mesh castShadow>
            <boxGeometry args={[1.2, 2.4, 0.15]} />
            <meshPhysicalMaterial
              color="#1a1a2e"
              metalness={0.9}
              roughness={0.1}
              clearcoat={1}
              clearcoatRoughness={0.05}
            />
          </mesh>
          {/* Screen */}
          <mesh position={[0, 0, 0.076]}>
            <planeGeometry args={[1.05, 2.2]} />
            <meshStandardMaterial color="#000814" emissive="#001133" emissiveIntensity={0.3} />
          </mesh>
        </group>

        {/* Reflective floor */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.8, 0]} receiveShadow>
          <planeGeometry args={[30, 30]} />
          <meshStandardMaterial color="#0a0a1e" metalness={0.95} roughness={0.15} />
        </mesh>
      </ThreeCanvas>

      {/* Overlay text via HTML (bisa dicampur!) */}
      <div style={{
        position: "absolute", bottom: 80, width: "100%", textAlign: "center",
        fontFamily: "sans-serif", color: "white", fontSize: 48, fontWeight: 700,
        opacity: interpolate(frame, [60, 90], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      }}>
        Premium Design ✨
      </div>
    </div>
  );
}
```

## 🔑 Tips Penting

1. **Selalu bungkus `<ThreeCanvas>` dalam div container** yang punya `width: 100%` dan `height: 100%`.
2. **Jangan gunakan `useFrame()` dari R3F** — Gunakan `useCurrentFrame()` dari Remotion.
3. **Bisa campurkan HTML overlay di atas 3D** — Letakkan elemen HTML `position: absolute` di atas ThreeCanvas untuk teks, subtitle, logo.
4. **Hindari orbitControls** — Ini untuk interaktif. Untuk video, gerakkan kamera secara manual lewat props `position` menggunakan `interpolate()`.
5. **Performance**: Untuk video panjang (>30 detik), gunakan geometri sederhana dan kurangi polygon count.
6. **Cahaya castShadow** membutuhkan objek penerima bayangan (`receiveShadow`) dan penghasil bayangan (`castShadow`).
