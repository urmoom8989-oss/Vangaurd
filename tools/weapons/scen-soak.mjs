export default { preset: 'weapons-hip', steps: Array.from({ length: 12 }, (_, i) => ({ name: 'soak' + i, frames: 10, shot: i % 4 === 3 })) };
