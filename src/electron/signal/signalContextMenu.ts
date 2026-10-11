import {
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
  clipboard,
} from 'electron';

// Signal Desktop attaches its right-click menu to its own BrowserWindow. The
// embedded Signal view has no such window, so the same items are built here
// (mirrors Signal 8.17's spell_check context menu).
export const signalContextMenuTemplate = (
  contents: WebContents,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] => {
  const { editFlags } = params;
  const isImage =
    params.mediaType === 'image' &&
    params.hasImageContents &&
    !params.selectionText.trim();
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion),
        });
      }
    } else {
      items.push({ label: '没有拼写建议', enabled: false });
    }
    items.push({ type: 'separator' });
  }

  if (params.isEditable) {
    if (editFlags.canUndo) items.push({ label: '撤销', click: () => contents.undo() });
    if (editFlags.canRedo) items.push({ label: '重做', click: () => contents.redo() });
    if (editFlags.canUndo || editFlags.canRedo) items.push({ type: 'separator' });
    if (editFlags.canCut) items.push({ label: '剪切', click: () => contents.cut() });
  }

  if (params.linkURL) {
    items.push({
      label: '复制链接',
      click: () => clipboard.writeText(params.linkURL),
    });
  } else if (isImage) {
    items.push({
      label: '复制图片',
      click: () => contents.copyImageAt(params.x, params.y),
    });
  } else if (editFlags.canCopy) {
    items.push({ label: '复制', click: () => contents.copy() });
  }

  if (editFlags.canPaste && !isImage) {
    items.push({ label: '粘贴', click: () => contents.paste() });
  }
  if (editFlags.canSelectAll && params.isEditable) {
    items.push({ label: '全选', click: () => contents.selectAll() });
  }

  return items;
};
