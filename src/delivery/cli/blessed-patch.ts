import * as blessed from "blessed";

/**
 * blessed's TerminalElement.render ignores term.term.ydisp,
 * making scrollback invisible. Patch instance render to account for it.
 */
export function patchTerminalScrollback(term: blessed.Widgets.TerminalElement): void {
  const t = term as any;
  t.render = function () {
    var ret = t._render();
    if (!ret) return;
    t.dattr = t.sattr(t.style);
    var xi = ret.xi + t.ileft, xl = ret.xl - t.iright,
      yi = ret.yi + t.itop, yl = ret.yl - t.ibottom, cursor,
      // FIX: scrollback = totalLines - visibleLines - (ybase - ydisp) so term.js's lines[screenY + ydisp] maps correctly
      scrollback = Math.max(0, term.term.lines.length - (yl - yi) - (term.term.ybase - term.term.ydisp));
    for (var y = Math.max(yi, 0); y < yl; y++) {
      var line = t.screen.lines[y];
      if (!line || !term.term.lines[scrollback + y - yi]) break;
      if (y === yi + term.term.y && term.term.cursorState
        && t.screen.focused === t
        && (term.term.ydisp === term.term.ybase || term.term.selectMode)
        && !term.term.cursorHidden) { cursor = xi + term.term.x; }
      else { cursor = -1; }
      for (var x = Math.max(xi, 0); x < xl; x++) {
        if (!line[x] || !term.term.lines[scrollback + y - yi][x - xi]) break;
        line[x][0] = term.term.lines[scrollback + y - yi][x - xi][0];
        if (x === cursor) {
          if (t.cursor === 'line') { line[x][0] = t.dattr; line[x][1] = '│'; continue; }
          else if (t.cursor === 'underline') line[x][0] = t.dattr | (2 << 18);
          else line[x][0] = t.dattr | (8 << 18);
        }
        line[x][1] = term.term.lines[scrollback + y - yi][x - xi][1];
        if (((line[x][0] >> 9) & 0x1ff) === 257)
          line[x][0] = (line[x][0] & ~(0x1ff << 9)) | (((t.dattr >> 9) & 0x1ff) << 9);
        if ((line[x][0] & 0x1ff) === 256)
          line[x][0] = (line[x][0] & ~0x1ff) | (t.dattr & 0x1ff);
      }
      line.dirty = true;
    }
    return ret;
  };
}
