/**
 * Coordinate-column picker for delimited-text point clouds.
 *
 * Delimited formats (CSV / TXT / XYZ / PTS / PTX …) don't guarantee that the
 * first three columns are X / Y / Z. This modal asks the user for the layout:
 * a 2D / 3D switch plus one column selector per axis, pre-filled with the
 * auto-detected mapping. It resolves to a `ColumnSelection`, or `null` when
 * the user cancels.
 */

import { autoCoordIndices } from '../io/text';
import type { ColumnSelection, TextColumnPreview } from '../io/common';
import { h, icon } from './dom';

/**
 * Show the column-picking dialog. Resolves with the chosen mapping, or `null`
 * if the user cancelled / closed it.
 */
export function askColumnSelection(preview: TextColumnPreview): Promise<ColumnSelection | null> {
  return new Promise((resolve) => {
    const ncols = preview.columns.length;
    const names = preview.columns.map((c) => c.name);
    const def = autoCoordIndices(ncols, names, preview.hasHeader);
    const can3d = ncols >= 3;

    const state: { mode: '2d' | '3d'; x: number; y: number; z: number } = {
      mode: can3d ? '3d' : '2d',
      x: def.x,
      y: def.y,
      z: def.z,
    };

    const delimLabel =
      preview.delim === 44 ? ',' : preview.delim === 59 ? ';' : preview.delim === 9 ? 'Tab' : '空格';

    /* ── mode segmented control ── */
    const seg2d = h('button', { class: 'seg-btn', type: 'button', text: '二维 (2D)' });
    const seg3d = h('button', {
      class: 'seg-btn',
      type: 'button',
      text: '三维 (3D)',
    }) as HTMLButtonElement;
    if (!can3d) {
      seg3d.disabled = true;
      seg3d.title = '列数不足 3 列，无法选择三维';
    }
    seg2d.classList.toggle('is-on', state.mode === '2d');
    seg3d.classList.toggle('is-on', state.mode === '3d');
    const seg = h('div', { class: 'seg' }, [seg2d, seg3d]);

    /* ── per-axis column selectors ── */
    const validityText = (col: { validCount: number; name: string }): string => {
      const ratio = preview.sampledRows > 0 ? `${col.validCount}/${preview.sampledRows}` : `${col.validCount}`;
      return col.validCount === 0 ? ` (${ratio} 有效 ⚠ 非数值)` : ` (${ratio} 有效)`;
    };
    const buildSelect = (axis: 'x' | 'y' | 'z'): HTMLSelectElement => {
      const sel = h('select', { class: 'select' }) as HTMLSelectElement;
      for (let c = 0; c < ncols; c++) {
        const col = preview.columns[c];
        const sample = col.sample.length ? col.sample.map(fmtSample).join(', ') : '—';
        sel.appendChild(
          h('option', { value: String(c) }, [`列 ${c + 1} · ${col.name}  ≈ ${sample}${validityText(col)}`])
        );
      }
      sel.value = String(state[axis]);
      sel.addEventListener('change', () => {
        state[axis] = Number(sel.value);
        updatePreview();
        errEl.hidden = true;
      });
      return sel;
    };

    const xSel = buildSelect('x');
    const ySel = buildSelect('y');
    const zSel = buildSelect('z');

    const mkField = (label: string, sel: HTMLSelectElement): HTMLElement =>
      h('div', { class: 'field' }, [
        h('label', { class: 'field-label' }, [label]),
        h('div', { class: 'select-wrap' }, [sel]),
      ]);

    const xField = mkField('X 坐标列', xSel);
    const yField = mkField('Y 坐标列', ySel);
    const zField = mkField('Z 坐标列', zSel);
    zField.hidden = state.mode !== '3d';
    const grid = h('div', { class: 'modal-cols' }, [xField, yField, zField]);

    const previewEl = h('div', { class: 'modal-preview' });
    const errEl = h('div', { class: 'modal-err', hidden: true });
    const note = h('div', { class: 'field-hint modal-note' }, [
      '二维模式：Z 坐标固定为 0（适用于平面 / 投影点云）。',
    ]);
    note.hidden = state.mode !== '2d';

    const modeField = h('div', { class: 'field' }, [
      h('label', { class: 'field-label' }, ['维度']),
      seg,
    ]);

    const body = h('div', { class: 'modal-body' }, [modeField, grid, errEl, previewEl, note]);

    /* ── header / footer ── */
    const title = h('div', { class: 'modal-title' }, ['选择坐标列']);
    const sub = h('div', {
      class: 'modal-sub',
      text: `共 ${ncols} 列 · 分隔符「${delimLabel}」· ${preview.hasHeader ? '含表头' : '无表头'}`,
    });
    const closeBtn = h('button', { class: 'icon-btn modal-close', type: 'button', title: '取消' }, [
      icon('close', 15),
    ]);
    const head = h('div', { class: 'modal-head' }, [
      h('div', { class: 'modal-head-text' }, [title, sub]),
      closeBtn,
    ]);

    const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', text: '取消' });
    const okBtn = h('button', { class: 'btn btn-primary', type: 'button', text: '确定载入' });
    const foot = h('div', { class: 'modal-foot' }, [cancelBtn, okBtn]);

    const card = h('div', { class: 'modal' }, [head, body, foot]);
    const backdrop = h('div', { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' }, [card]);

    /* ── behaviour ── */
    function fmtSample(v: number): string {
      if (!Number.isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(1);
      if (Number.isInteger(v)) return String(v);
      return v.toFixed(a < 10 ? 3 : 2);
    }

    /** How many sampled rows would actually parse for the current selection. */
    function predictedValidCount(): number {
      let n = 0;
      for (const row of preview.rows) {
        const xv = row[state.x];
        const yv = row[state.y];
        const zv = state.mode === '3d' ? row[state.z] : 0;
        if (Number.isFinite(xv) && Number.isFinite(yv) && (state.mode === '2d' || Number.isFinite(zv))) n++;
      }
      return n;
    }

    function updatePreview(): void {
      const axes: Array<[string, number]> = [['X', state.x], ['Y', state.y]];
      if (state.mode === '3d') axes.push(['Z', state.z]);
      previewEl.innerHTML = '';
      previewEl.appendChild(h('div', { class: 'modal-preview-label', text: '当前选择预览' }));
      for (const [ax, c] of axes) {
        const col = preview.columns[c];
        const sample = col && col.sample.length ? col.sample.map(fmtSample).join(', ') : '—';
        const validity = col ? validityText(col) : '';
        previewEl.appendChild(
          h('div', { class: 'modal-preview-row' }, [
            `${ax} = 列 ${c + 1}（${col ? col.name : '?'}）  ≈ ${sample}${validity}`,
          ])
        );
      }
      const predicted = predictedValidCount();
      const total = preview.rows.length;
      const predRow = h('div', { class: 'modal-preview-row modal-pred' }, [
        `预计有效点：${predicted} / ${total}（采样行）`,
      ]);
      if (predicted === 0 && total > 0) predRow.classList.add('is-warn');
      previewEl.appendChild(predRow);
    }

    function setMode(m: '2d' | '3d'): void {
      state.mode = m;
      seg2d.classList.toggle('is-on', m === '2d');
      seg3d.classList.toggle('is-on', m === '3d');
      zField.hidden = m !== '3d';
      note.hidden = m !== '2d';
      updatePreview();
    }
    seg2d.addEventListener('click', () => setMode('2d'));
    seg3d.addEventListener('click', () => setMode('3d'));

    function cleanup(): void {
      window.removeEventListener('keydown', onKey);
      backdrop.remove();
    }

    function confirm(): void {
      const used = new Set<number>();
      const axes = state.mode === '3d' ? [state.x, state.y, state.z] : [state.x, state.y];
      const axisNames = state.mode === '3d' ? ['X', 'Y', 'Z'] : ['X', 'Y'];
      for (let k = 0; k < axes.length; k++) {
        const c = axes[k];
        if (used.has(c)) {
          errEl.textContent = 'X / Y' + (state.mode === '3d' ? ' / Z' : '') + ' 必须选择不同的列。';
          errEl.hidden = false;
          return;
        }
        used.add(c);
        const col = preview.columns[c];
        if (col && col.validCount === 0) {
          errEl.textContent = `${axisNames[k]} 列（列 ${c + 1} · ${col.name}）在 ${preview.sampledRows} 行样本中无任何有效数字，请选择数值列。`;
          errEl.hidden = false;
          return;
        }
      }
      // A column may have *some* valid numbers yet never line up with the
      // others on the same row (interleaved / misaligned data) — that still
      // yields an empty cloud, so block it here with a clear reason.
      const predicted = predictedValidCount();
      if (predicted === 0) {
        errEl.textContent = `所选 X / Y${state.mode === '3d' ? ' / Z' : ''} 坐标列在 ${preview.rows.length} 行样本中没有任何一行同时包含有效数值，载入将得到空点云。请重新选择坐标列或检查分隔符。`;
        errEl.hidden = false;
        return;
      }
      errEl.hidden = true;
      const selection: ColumnSelection = {
        mode: state.mode,
        x: state.x,
        y: state.y,
        z: state.mode === '3d' ? state.z : -1,
      };
      cleanup();
      resolve(selection);
    }

    function cancel(): void {
      cleanup();
      resolve(null);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };

    closeBtn.addEventListener('click', cancel);
    cancelBtn.addEventListener('click', cancel);
    okBtn.addEventListener('click', confirm);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) cancel();
    });
    window.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    setMode(state.mode);
    updatePreview();
    // Focus the first selector so keyboard / screen-reader users land inside.
    setTimeout(() => xSel.focus(), 0);
  });
}
