import DxfParser from 'dxf-parser';

const ARC_STEP = Math.PI / 36; // 圆弧离散精度：5°
const MAX_INSERT_DEPTH = 6;
const MAX_SEGMENTS = 2000000; // 防止异常文件把浏览器内存撑爆

/*
 * 把 DXF 文本转换成可直接绘制的线段集合。
 * 返回的坐标已经以图形中心为原点做平移，避免大坐标在 Float32 下抖动。
 */
export function parseDxf(text) {
  const dxf = new DxfParser().parseSync(text);
  if (!dxf || !Array.isArray(dxf.entities) || dxf.entities.length === 0) {
    throw new Error('empty');
  }

  const blocks = dxf.blocks || {};
  const positions = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let segments = 0;

  function emit(x1, y1, x2, y2) {
    if (segments >= MAX_SEGMENTS) return;
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
    positions.push(x1, y1, 0, x2, y2, 0);
    segments++;
    if (x1 < minX) minX = x1;
    if (x1 > maxX) maxX = x1;
    if (y1 < minY) minY = y1;
    if (y1 > maxY) maxY = y1;
    if (x2 < minX) minX = x2;
    if (x2 > maxX) maxX = x2;
    if (y2 < minY) minY = y2;
    if (y2 > maxY) maxY = y2;
  }

  function emitTransformed(m, x1, y1, x2, y2) {
    emit(
      m[0] * x1 + m[2] * y1 + m[4],
      m[1] * x1 + m[3] * y1 + m[5],
      m[0] * x2 + m[2] * y2 + m[4],
      m[1] * x2 + m[3] * y2 + m[5]
    );
  }

  function emitPath(m, pts, closed) {
    for (let i = 1; i < pts.length; i++) {
      emitTransformed(m, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    }
    if (closed && pts.length > 2) {
      const last = pts[pts.length - 1];
      emitTransformed(m, last.x, last.y, pts[0].x, pts[0].y);
    }
  }

  function walk(entities, m, depth) {
    if (depth > MAX_INSERT_DEPTH) return;
    for (const e of entities) {
      if (segments >= MAX_SEGMENTS) return;
      if (!e || e.visible === false || e.inPaperSpace) continue;

      switch (e.type) {
        case 'LINE': {
          const v = e.vertices || [];
          if (v.length >= 2) emitTransformed(m, v[0].x, v[0].y, v[1].x, v[1].y);
          break;
        }
        case 'CIRCLE': {
          if (!e.center || !(e.radius > 0)) break;
          emitPath(m, arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2), false);
          break;
        }
        case 'ARC': {
          if (!e.center || !(e.radius > 0)) break;
          let sweep = e.endAngle - e.startAngle;
          while (sweep <= 0) sweep += Math.PI * 2;
          emitPath(m, arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, sweep), false);
          break;
        }
        case 'ELLIPSE': {
          if (!e.center || !e.majorAxisEndPoint) break;
          const mx = e.majorAxisEndPoint.x;
          const my = e.majorAxisEndPoint.y;
          const ratio = e.axisRatio > 0 ? e.axisRatio : 1;
          // 短轴 = 长轴端点向量旋转 90° 后按比例缩放
          const nx = -my * ratio;
          const ny = mx * ratio;
          let sweep = (e.endAngle || 0) - (e.startAngle || 0);
          while (sweep <= 0) sweep += Math.PI * 2;
          const steps = Math.max(8, Math.ceil(sweep / ARC_STEP));
          const pts = [];
          for (let i = 0; i <= steps; i++) {
            const t = (e.startAngle || 0) + (sweep * i) / steps;
            pts.push({
              x: e.center.x + mx * Math.cos(t) + nx * Math.sin(t),
              y: e.center.y + my * Math.cos(t) + ny * Math.sin(t),
            });
          }
          emitPath(m, pts, false);
          break;
        }
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (e.isPolyfaceMesh || e.is3dPolygonMesh) break;
          const verts = (e.vertices || []).filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y));
          if (verts.length < 2) break;
          emitPath(m, polylinePoints(verts, !!e.shape), false);
          break;
        }
        case 'SPLINE': {
          const pts = splinePoints(e);
          if (pts.length >= 2) emitPath(m, pts, false);
          break;
        }
        case 'SOLID':
        case '3DFACE': {
          const raw = e.points || e.vertices || [];
          const pts = [];
          for (const p of raw) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const last = pts[pts.length - 1];
            if (last && last.x === p.x && last.y === p.y) continue;
            pts.push(p);
          }
          if (pts.length === 3) {
            emitPath(m, pts, true);
          } else if (pts.length >= 4) {
            // SOLID / 3DFACE 的第 3、4 个顶点在 DXF 中顺序是反的
            const quad = [pts[0], pts[1], pts[3], pts[2]];
            emitPath(m, quad, true);
          }
          break;
        }
        case 'INSERT': {
          const block = blocks[e.name];
          if (!block || !Array.isArray(block.entities)) break;
          const rot = ((e.rotation || 0) * Math.PI) / 180;
          const sx = e.xScale == null ? 1 : e.xScale;
          const sy = e.yScale == null ? 1 : e.yScale;
          const bx = block.position ? block.position.x : 0;
          const by = block.position ? block.position.y : 0;
          const cols = Math.max(1, e.columnCount || 1);
          const rows = Math.max(1, e.rowCount || 1);
          const cs = e.columnSpacing || 0;
          const rs = e.rowSpacing || 0;
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          const px0 = e.position ? e.position.x : 0;
          const py0 = e.position ? e.position.y : 0;

          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const px = px0 + c * cs;
              const py = py0 + r * rs;
              const local = [
                cos * sx,
                sin * sx,
                -sin * sy,
                cos * sy,
                px - (cos * sx * bx + -sin * sy * by),
                py - (sin * sx * bx + cos * sy * by),
              ];
              walk(block.entities, mul(m, local), depth + 1);
            }
          }
          break;
        }
        case 'DIMENSION': {
          // 标注的图形存放在匿名块里，坐标已是世界坐标
          const block = blocks[e.block];
          if (block && Array.isArray(block.entities)) walk(block.entities, m, depth + 1);
          break;
        }
        default:
          // TEXT / MTEXT / POINT / ATTDEF 等暂不绘制
          break;
      }
    }
  }

  walk(dxf.entities, [1, 0, 0, 1, 0, 0], 0);

  if (segments === 0) throw new Error('empty');

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const centered = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    centered[i] = positions[i] - cx;
    centered[i + 1] = positions[i + 1] - cy;
    centered[i + 2] = 0;
  }

  return {
    positions: centered,
    width: maxX - minX,
    height: maxY - minY,
    segments,
  };
}

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function arcPoints(cx, cy, r, startAngle, sweep) {
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = startAngle + (sweep * i) / steps;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// 顶点 bulge（圆弧凸度）展开成折线点
function polylinePoints(verts, closed) {
  const pts = [];
  const n = verts.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    pts.push({ x: a.x, y: a.y });
    if (a.bulge) appendBulge(pts, a, b, a.bulge);
  }
  if (!closed) {
    pts.push({ x: verts[n - 1].x, y: verts[n - 1].y });
  } else if (!verts[n - 1].bulge) {
    // 闭合且末点无凸度时，补上回到起点的收尾边
    pts.push({ x: verts[0].x, y: verts[0].y });
  }
  return pts;
}

function appendBulge(pts, a, b, bulge) {
  const theta = 4 * Math.atan(bulge);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (!chord) return;

  const d = chord / 2 / Math.tan(theta / 2);
  const cx = (a.x + b.x) / 2 - (dy / chord) * d;
  const cy = (a.y + b.y) / 2 + (dx / chord) * d;
  const radius = Math.hypot(a.x - cx, a.y - cy);
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const steps = Math.max(2, Math.ceil(Math.abs(theta) / ARC_STEP));

  for (let i = 1; i <= steps; i++) {
    const ang = a0 + (theta * i) / steps;
    pts.push({ x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) });
  }
}

function splinePoints(e) {
  const cps = e.controlPoints || [];
  const degree = Math.max(1, Math.min(e.degreeOfSplineCurve || 3, cps.length - 1));
  const knots = e.knotValues;

  if (cps.length >= 2 && Array.isArray(knots) && knots.length >= cps.length + degree + 1) {
    const t0 = knots[degree];
    const t1 = knots[cps.length];
    const steps = Math.min(1200, Math.max(24, cps.length * 8));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i === steps ? t1 - 1e-9 : t0 + ((t1 - t0) * i) / steps;
      pts.push(deBoor(knots, cps, degree, Math.min(Math.max(t, t0), t1 - 1e-9)));
    }
    return pts;
  }
  if (cps.length >= 2) return cps;
  return e.fitPoints || [];
}

// de Boor 算法求 B 样条上的点
function deBoor(knots, cps, p, t) {
  const n = cps.length;
  let k = p;
  while (k < n - 1 && t >= knots[k + 1]) k++;

  const d = [];
  for (let j = 0; j <= p; j++) {
    const cp = cps[k - p + j];
    d[j] = { x: cp.x, y: cp.y };
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const denom = knots[k + 1 + j - r] - knots[k - p + j];
      const a = denom === 0 ? 0 : (t - knots[k - p + j]) / denom;
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y,
      };
    }
  }
  return d[p];
}
