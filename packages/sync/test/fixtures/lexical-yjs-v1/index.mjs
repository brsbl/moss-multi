// Test fixture (T3.B31b): the @lexical/yjs 0.48.0 binding as patched before the lean stored layout, byte for byte
// below this comment. It writes every property of a node, as an older client does, and reads a doc as one does.
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import { $isDecoratorNode, $getNodeByKey, $isLineBreakNode, $isTextNode, $getSelection, $isRangeSelection, $isElementNode, $createChildrenArray, $getNodeByKeyOrThrow, $removeFromParent, isLexicalEditor, createEditor, $getSlotNames, $getSlot, $removeSlot, $setSlot, $isRootNode, $getWritableNodeState, getDeclaredSlots, $getRoot, RootNode, ElementNode, TextNode, $getState, createState, getRootOwnerDocument, setDOMStyleObject, isDOMShadowRoot, COLLABORATION_TAG, HISTORIC_TAG, $addUpdateTag, SKIP_SCROLL_INTO_VIEW_TAG, $createParagraphNode, createCommand } from 'lexical';
import { XmlText, XmlElement, Map as Map$1, Doc, typeListToArraySnapshot, Snapshot, typeMapGetAllSnapshot, isDeleted, XmlHook, ContentString, ContentFormat, emptySnapshot, PermanentUserData, iterateDeletedStructs, snapshot, createAbsolutePositionFromRelativePosition, createRelativePositionFromTypeIndex, compareRelativePositions, Item, YMapEvent, YTextEvent, YXmlEvent, UndoManager } from 'yjs';
import { createDOMRange, createRectsFromDOMRange } from '@lexical/selection';

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Do not require this module directly! Use normal `invariant` calls.

function formatDevErrorMessage(message) {
  throw new Error(message);
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

function simpleDiffWithCursor(a, b, cursor) {
  const aLength = a.length;
  const bLength = b.length;
  let left = 0; // number of same characters counting from left
  let right = 0; // number of same characters counting from right
  // Iterate left to the right until we find a changed character
  // First iteration considers the current cursor position
  while (left < aLength && left < bLength && a[left] === b[left] && left < cursor) {
    left++;
  }
  // Iterate right to the left until we find a changed character
  while (right + left < aLength && right + left < bLength && a[aLength - right - 1] === b[bLength - right - 1]) {
    right++;
  }
  // Try to iterate left further to the right without caring about the current cursor position
  while (right + left < aLength && right + left < bLength && a[left] === b[left]) {
    left++;
  }
  return {
    index: left,
    insert: b.slice(left, bLength - right),
    remove: aLength - left - right
  };
}

class CollabDecoratorNode {
  _xmlElem;
  _key;
  // Normally a decorator's parent is an element, but a slot-value decorator
  // hosted by another decorator has that decorator as its parent.
  _parent;
  _type;
  constructor(xmlElem, parent, type) {
    this._key = '';
    this._xmlElem = xmlElem;
    this._parent = parent;
    this._type = type;
  }
  getPrevNode(nodeMap) {
    if (nodeMap === null) {
      return null;
    }
    const node = nodeMap.get(this._key);
    return $isDecoratorNode(node) ? node : null;
  }
  getNode() {
    const node = $getNodeByKey(this._key);
    return $isDecoratorNode(node) ? node : null;
  }
  getSharedType() {
    return this._xmlElem;
  }
  getType() {
    return this._type;
  }
  getKey() {
    return this._key;
  }
  getSize() {
    return 1;
  }
  getOffset() {
    // A slot-value decorator has a decorator parent, but slots live outside the
    // linked-list children channel so getOffset is never called on one. Only an
    // element parent exposes getChildOffset, so narrow before dereferencing.
    if (!!(this._parent instanceof CollabDecoratorNode)) {
      formatDevErrorMessage(`getOffset: expected parent to be a collab element node`);
    }
    return this._parent.getChildOffset(this);
  }
  syncPropertiesFromLexical(binding, nextLexicalNode, prevNodeMap) {
    const prevLexicalNode = this.getPrevNode(prevNodeMap);
    const xmlElem = this._xmlElem;
    syncPropertiesFromLexical(binding, xmlElem, prevLexicalNode, nextLexicalNode);
  }
  syncPropertiesFromYjs(binding, keysChanged) {
    const lexicalNode = this.getNode();
    if (lexicalNode === null) {
      // Concurrently removed from Lexical; nothing to sync.
      return;
    }
    const xmlElem = this._xmlElem;
    $syncPropertiesFromYjs(binding, xmlElem, lexicalNode, keysChanged);
  }

  // Reconcile named slots from the `__slots` Y.Map attribute on this decorator's
  // `_xmlElem` into the lexical node. A decorator host has no children channel,
  // so slots are its only structural descendants. Mirrors
  // CollabElementNode.syncSlotsFromYjs but reads `_xmlElem` instead of
  // `_xmlText`.
  syncSlotsFromYjs(binding, lexicalNode) {
    $syncSlotsFromYjsShared(binding, this._xmlElem, lexicalNode, this);
  }

  // Mirror of the lexical slot map into the `__slots` Y.Map attribute on this
  // decorator's `_xmlElem`. Local (lexical -> yjs) counterpart of
  // syncSlotsFromYjs. Mirrors CollabElementNode.syncSlotsFromLexical but writes
  // `_xmlElem` instead of `_xmlText`.
  syncSlotsFromLexical(binding, nextLexicalNode, prevNodeMap, dirtyElements, dirtyLeaves) {
    $syncSlotsFromLexicalShared(binding, this._xmlElem, nextLexicalNode, prevNodeMap, dirtyElements, dirtyLeaves, this);
  }
  destroy(binding) {
    const collabNodeMap = binding.collabNodeMap;

    // A decorator host has no children channel; its slots are its only
    // descendants. Destroy each slot's collab node so it doesn't dangle in
    // binding.collabNodeMap after the host is removed. The host's `_xmlElem`
    // must still be attached here for SLOTS_ATTR_KEY to read back.
    $destroySlotsShared(binding, this._xmlElem);
    if (collabNodeMap.get(this._key) === this) {
      collabNodeMap.delete(this._key);
    }
  }
}
// moss-multi patch (T3.B31a): collab nodes are recorded through the binding's `collabNodesByType`.
function $createCollabDecoratorNode(xmlElem, parent, type, collabNodesByType) {
  const collabNode = new CollabDecoratorNode(xmlElem, parent, type);
  collabNodesByType.set(xmlElem, collabNode);
  return collabNode;
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

class CollabLineBreakNode {
  _map;
  _key;
  _parent;
  _type;
  constructor(map, parent) {
    this._key = '';
    this._map = map;
    this._parent = parent;
    this._type = 'linebreak';
  }
  getNode() {
    const node = $getNodeByKey(this._key);
    return $isLineBreakNode(node) ? node : null;
  }
  getKey() {
    return this._key;
  }
  getSharedType() {
    return this._map;
  }
  getType() {
    return this._type;
  }
  getSize() {
    return 1;
  }
  getOffset() {
    const collabElementNode = this._parent;
    return collabElementNode.getChildOffset(this);
  }
  destroy(binding) {
    const collabNodeMap = binding.collabNodeMap;
    if (collabNodeMap.get(this._key) === this) {
      collabNodeMap.delete(this._key);
    }
  }
}
// moss-multi patch (T3.B31a): collab nodes are recorded through the binding's `collabNodesByType`.
function $createCollabLineBreakNode(map, parent, collabNodesByType) {
  const collabNode = new CollabLineBreakNode(map, parent);
  collabNodesByType.set(map, collabNode);
  return collabNode;
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

function $diffTextContentAndApplyDelta(collabNode, key, prevText, nextText) {
  const selection = $getSelection();
  let cursorOffset = nextText.length;
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    const anchor = selection.anchor;
    if (anchor.key === key) {
      cursorOffset = anchor.offset;
    }
  }
  const diff = simpleDiffWithCursor(prevText, nextText, cursorOffset);
  collabNode.spliceText(diff.index, diff.remove, diff.insert);
}
class CollabTextNode {
  _map;
  _key;
  _parent;
  _text;
  _type;
  _normalized;
  constructor(map, text, parent, type) {
    this._key = '';
    this._map = map;
    this._parent = parent;
    this._text = text;
    this._type = type;
    this._normalized = false;
  }
  getPrevNode(nodeMap) {
    if (nodeMap === null) {
      return null;
    }
    const node = nodeMap.get(this._key);
    return $isTextNode(node) ? node : null;
  }
  getNode() {
    const node = $getNodeByKey(this._key);
    return $isTextNode(node) ? node : null;
  }
  getSharedType() {
    return this._map;
  }
  getType() {
    return this._type;
  }
  getKey() {
    return this._key;
  }
  getSize() {
    return this._text.length + (this._normalized ? 0 : 1);
  }
  getOffset() {
    const collabElementNode = this._parent;
    return collabElementNode.getChildOffset(this);
  }
  spliceText(index, delCount, newText) {
    const collabElementNode = this._parent;
    const xmlText = collabElementNode._xmlText;
    const offset = this.getOffset() + 1 + index;
    if (delCount !== 0) {
      xmlText.delete(offset, delCount);
    }
    if (newText !== '') {
      xmlText.insert(offset, newText);
    }
  }
  syncPropertiesAndTextFromLexical(binding, nextLexicalNode, prevNodeMap) {
    const prevLexicalNode = this.getPrevNode(prevNodeMap);
    const nextText = nextLexicalNode.__text;
    syncPropertiesFromLexical(binding, this._map, prevLexicalNode, nextLexicalNode);
    if (prevLexicalNode !== null) {
      const prevText = prevLexicalNode.__text;
      if (prevText !== nextText) {
        const key = nextLexicalNode.__key;
        $diffTextContentAndApplyDelta(this, key, prevText, nextText);
        this._text = nextText;
      }
    }
  }
  syncPropertiesAndTextFromYjs(binding, keysChanged) {
    const lexicalNode = this.getNode();
    if (lexicalNode === null) {
      // Concurrently removed from Lexical; nothing to sync.
      return;
    }
    $syncPropertiesFromYjs(binding, this._map, lexicalNode, keysChanged);
    const collabText = this._text;
    if (lexicalNode.__text !== collabText) {
      lexicalNode.setTextContent(collabText);
    }
  }
  destroy(binding) {
    const collabNodeMap = binding.collabNodeMap;
    if (collabNodeMap.get(this._key) === this) {
      collabNodeMap.delete(this._key);
    }
  }
}
// moss-multi patch (T3.B31a): collab nodes are recorded through the binding's `collabNodesByType`.
function $createCollabTextNode(map, text, parent, type, collabNodesByType) {
  const collabNode = new CollabTextNode(map, text, parent, type);
  collabNodesByType.set(map, collabNode);
  return collabNode;
}

class CollabElementNode {
  _key;
  _children;
  _xmlText;
  _type;
  // Normally an element's parent is another element, but a slot-value element
  // hosted by a decorator has that decorator as its parent.
  _parent;
  constructor(xmlText, parent, type) {
    this._key = '';
    this._children = [];
    this._xmlText = xmlText;
    this._type = type;
    this._parent = parent;
  }
  getPrevNode(nodeMap) {
    if (nodeMap === null) {
      return null;
    }
    const node = nodeMap.get(this._key);
    return $isElementNode(node) ? node : null;
  }
  getNode() {
    const node = $getNodeByKey(this._key);
    return $isElementNode(node) ? node : null;
  }
  getSharedType() {
    return this._xmlText;
  }
  getType() {
    return this._type;
  }
  getKey() {
    return this._key;
  }
  isEmpty() {
    return this._children.length === 0;
  }
  getSize() {
    return 1;
  }
  getOffset() {
    const collabElementNode = this._parent;
    // A slot-value element has a decorator parent, but slots live outside the
    // linked-list children channel so getOffset is never called on one — only
    // real children (whose parent is an element) reach here.
    if (!(collabElementNode instanceof CollabElementNode)) {
      formatDevErrorMessage(`getOffset: could not find collab element node`);
    }
    return collabElementNode.getChildOffset(this);
  }
  syncPropertiesFromYjs(binding, keysChanged) {
    const lexicalNode = this.getNode();
    if (lexicalNode === null) {
      // Concurrently removed from Lexical; nothing to sync.
      return;
    }
    $syncPropertiesFromYjs(binding, this._xmlText, lexicalNode, keysChanged);
  }
  applyChildrenYjsDelta(binding, deltas) {
    const children = this._children;
    let currIndex = 0;
    let pendingSplitText = null;
    // moss-multi patch (T3.S6): a delta of n embeds cost O(n²): every lookup scanned from the first child. Each lookup
    // now resumes from the child before the last one found, whose offset no later mutation in this loop changes.
    let hintIndex = 0;
    let hintOffset = 0;
    const locate = (offset, boundaryIsEdge) => {
      if (hintIndex >= children.length || hintIndex > 0 && hintOffset >= offset) {
        hintIndex = 0;
        hintOffset = 0;
      }
      const position = getPositionFromElementAndOffset(this, offset, boundaryIsEdge, hintIndex, hintOffset);
      const before = position.nodeIndex - 1;
      if (before >= hintIndex && before < children.length) {
        hintOffset = position.start - children[before].getSize();
        hintIndex = before;
      } else {
        hintIndex = 0;
        hintOffset = 0;
      }
      return position;
    };
    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i];
      const insertDelta = delta.insert;
      const deleteDelta = delta.delete;
      if (delta.retain != null) {
        currIndex += delta.retain;
      } else if (typeof deleteDelta === 'number') {
        let deletionSize = deleteDelta;
        while (deletionSize > 0) {
          const {
            node,
            nodeIndex,
            offset,
            length
          } = locate(currIndex, false);
          if (node instanceof CollabElementNode || node instanceof CollabLineBreakNode || node instanceof CollabDecoratorNode) {
            // moss-multi patch (T3.S6): the following embeds sit at the same offset in turn; remove the run at once.
            let run = 1;
            while (run < deletionSize && nodeIndex + run < children.length && !(children[nodeIndex + run] instanceof CollabTextNode)) {
              run++;
            }
            children.splice(nodeIndex, run);
            deletionSize -= run;
          } else if (node instanceof CollabTextNode) {
            const delCount = Math.min(deletionSize, length);
            const prevCollabNode = nodeIndex !== 0 ? children[nodeIndex - 1] : null;
            const nodeSize = node.getSize();
            if (offset === 0 && length === nodeSize) {
              // Text node has been deleted.
              children.splice(nodeIndex, 1);
              // If this was caused by an undo from YJS, there could be dangling text.
              const danglingText = spliceString(node._text, offset, delCount - 1, '');
              if (danglingText.length > 0) {
                if (prevCollabNode instanceof CollabTextNode) {
                  // Merge the text node with previous.
                  prevCollabNode._text += danglingText;
                } else {
                  // No previous text node to merge into, just delete the text.
                  this._xmlText.delete(offset, danglingText.length);
                }
              }
            } else {
              node._text = spliceString(node._text, offset, delCount, '');
            }
            deletionSize -= delCount;
          } else {
            // Can occur due to the deletion from the dangling text heuristic below.
            break;
          }
        }
      } else if (insertDelta != null) {
        if (typeof insertDelta === 'string') {
          const {
            node,
            offset
          } = locate(currIndex, true);
          if (node instanceof CollabTextNode) {
            node._text = spliceString(node._text, offset, 0, insertDelta);
          } else {
            // TODO: maybe we can improve this by keeping around a redundant
            // text node map, rather than removing all the text nodes, so there
            // never can be dangling text.

            // We have a conflict where there was likely a CollabTextNode and
            // an Lexical TextNode too, but they were removed in a merge. So
            // let's just ignore the text and trigger a removal for it from our
            // shared type.
            this._xmlText.delete(offset, insertDelta.length);
          }
          currIndex += insertDelta.length;
        } else {
          const sharedType = insertDelta;
          // A delta can reference a shared type that has already been deleted
          // (e.g. while reconciling an undo against concurrent remote edits). A
          // deleted type has no `__type` and must not be materialized into the
          // collab tree; it carries no live content, so skip it entirely.
          if (getNodeTypeFromSharedType(sharedType) === undefined) {
            continue;
          }
          const {
            node,
            nodeIndex,
            length
          } = locate(currIndex, false);
          const collabNode = $getOrInitCollabNodeFromSharedType(binding, sharedType, this);
          if (node instanceof CollabTextNode && length > 0 && length < node._text.length) {
            // Trying to insert in the middle of a text node; split the text.
            const text = node._text;
            const splitIdx = text.length - length;
            node._text = spliceString(text, splitIdx, length, '');
            children.splice(nodeIndex + 1, 0, collabNode);
            // The insert that triggers the text split might not be a text node. Need to keep a
            // reference to the remaining text so that it can be added when we do create one.
            pendingSplitText = spliceString(text, 0, splitIdx, '');
          } else {
            children.splice(nodeIndex, 0, collabNode);
          }
          if (pendingSplitText !== null && collabNode instanceof CollabTextNode) {
            // Found a text node to insert the pending text into.
            collabNode._text = pendingSplitText + collabNode._text;
            pendingSplitText = null;
          }
          currIndex += 1;
        }
      } else {
        throw new Error('Unexpected delta format');
      }
    }
  }
  syncChildrenFromYjs(binding) {
    // Now diff the children of the collab node with that of our existing Lexical node.
    const lexicalNode = this.getNode();
    if (lexicalNode === null) {
      // The Lexical node was concurrently removed (e.g. by a remote edit or undo)
      // while we still have a pending change for it. There is nothing to reconcile
      // into Lexical; this collab node will be cleaned up when its parent syncs.
      return;
    }
    const key = lexicalNode.__key;
    const prevLexicalChildrenKeys = $createChildrenArray(lexicalNode, null);
    const lexicalChildrenKeysLength = prevLexicalChildrenKeys.length;
    const collabChildren = this._children;
    const collabChildrenLength = collabChildren.length;
    const collabNodeMap = binding.collabNodeMap;
    const visitedKeys = new Set();
    let collabKeys;
    let writableLexicalNode;
    let prevIndex = 0;
    let prevChildNode = null;
    if (collabChildrenLength !== lexicalChildrenKeysLength) {
      writableLexicalNode = lexicalNode.getWritable();
    }
    for (let i = 0; i < collabChildrenLength; i++) {
      const lexicalChildKey = prevLexicalChildrenKeys[prevIndex];
      const childCollabNode = collabChildren[i];
      const collabLexicalChildNode = childCollabNode.getNode();
      const collabKey = childCollabNode._key;
      if (collabLexicalChildNode !== null && lexicalChildKey === collabKey) {
        const childNeedsUpdating = $isTextNode(collabLexicalChildNode);
        // Update
        visitedKeys.add(lexicalChildKey);
        if (childNeedsUpdating) {
          childCollabNode._key = lexicalChildKey;
          if (childCollabNode instanceof CollabElementNode) {
            const xmlText = childCollabNode._xmlText;
            childCollabNode.syncPropertiesFromYjs(binding, null);
            childCollabNode.applyChildrenYjsDelta(binding, xmlText.toDelta());
            childCollabNode.syncChildrenFromYjs(binding);
          } else if (childCollabNode instanceof CollabTextNode) {
            childCollabNode.syncPropertiesAndTextFromYjs(binding, null);
          } else if (childCollabNode instanceof CollabDecoratorNode) {
            childCollabNode.syncPropertiesFromYjs(binding, null);
          } else if (!(childCollabNode instanceof CollabLineBreakNode)) {
            {
              formatDevErrorMessage(`syncChildrenFromYjs: expected text, element, decorator, or linebreak collab node`);
            }
          }
        }
        prevChildNode = collabLexicalChildNode;
        prevIndex++;
      } else {
        if (collabKeys === undefined) {
          collabKeys = new Set();
          for (let s = 0; s < collabChildrenLength; s++) {
            const child = collabChildren[s];
            const childKey = child._key;
            if (childKey !== '') {
              collabKeys.add(childKey);
            }
          }
        }
        if (collabLexicalChildNode !== null && lexicalChildKey !== undefined && !collabKeys.has(lexicalChildKey)) {
          const nodeToRemove = $getNodeByKeyOrThrow(lexicalChildKey);
          $removeFromParent(nodeToRemove);
          i--;
          prevIndex++;
          continue;
        }
        writableLexicalNode = lexicalNode.getWritable();
        // Create/Replace
        const lexicalChildNode = createLexicalNodeFromCollabNode(binding, childCollabNode, key);
        const childKey = lexicalChildNode.__key;
        collabNodeMap.set(childKey, childCollabNode);
        if (prevChildNode === null) {
          const nextSibling = writableLexicalNode.getFirstChild();
          writableLexicalNode.__first = childKey;
          if (nextSibling !== null) {
            const writableNextSibling = nextSibling.getWritable();
            writableNextSibling.__prev = childKey;
            lexicalChildNode.__next = writableNextSibling.__key;
          }
        } else {
          const writablePrevChildNode = prevChildNode.getWritable();
          const nextSibling = prevChildNode.getNextSibling();
          writablePrevChildNode.__next = childKey;
          lexicalChildNode.__prev = prevChildNode.__key;
          if (nextSibling !== null) {
            const writableNextSibling = nextSibling.getWritable();
            writableNextSibling.__prev = childKey;
            lexicalChildNode.__next = writableNextSibling.__key;
          }
        }
        if (i === collabChildrenLength - 1) {
          writableLexicalNode.__last = childKey;
        }
        writableLexicalNode.__size++;
        prevChildNode = lexicalChildNode;
      }
    }
    for (let i = 0; i < lexicalChildrenKeysLength; i++) {
      const lexicalChildKey = prevLexicalChildrenKeys[i];
      if (!visitedKeys.has(lexicalChildKey)) {
        // Remove
        const lexicalChildNode = $getNodeByKeyOrThrow(lexicalChildKey);
        const collabNode = binding.collabNodeMap.get(lexicalChildKey);
        if (collabNode !== undefined) {
          collabNode.destroy(binding);
        }
        $removeFromParent(lexicalChildNode);
      }
    }
    this.syncSlotsFromYjs(binding, lexicalNode);
  }

  // Reconcile named slots from the `__slots` Y.Map attribute on this element's
  // `_xmlText` into the lexical node. Slots live outside the linked-list
  // children channel, so they are not reached by the delta-driven children
  // reconcile above. This diff serves both initial fresh-restore and the
  // observer path: a name present in the Y.Map but missing on the lexical node
  // is added, a name present on the lexical node but gone from the Y.Map is
  // removed, and a name present on both is left untouched (its own
  // text/children edits flow through the slot's CollabElementNode YTextEvent).
  syncSlotsFromYjs(binding, lexicalNode) {
    $syncSlotsFromYjsShared(binding, this._xmlText, lexicalNode, this);
  }
  syncPropertiesFromLexical(binding, nextLexicalNode, prevNodeMap) {
    syncPropertiesFromLexical(binding, this._xmlText, this.getPrevNode(prevNodeMap), nextLexicalNode);
  }
  _syncChildFromLexical(binding, index, key, prevNodeMap, dirtyElements, dirtyLeaves) {
    const childCollabNode = this._children[index];
    // Update
    const nextChildNode = $getNodeByKeyOrThrow(key);
    if (childCollabNode instanceof CollabElementNode && $isElementNode(nextChildNode)) {
      childCollabNode.syncPropertiesFromLexical(binding, nextChildNode, prevNodeMap);
      childCollabNode.syncChildrenFromLexical(binding, nextChildNode, prevNodeMap, dirtyElements, dirtyLeaves);
      childCollabNode.syncSlotsFromLexical(binding, nextChildNode, prevNodeMap, dirtyElements, dirtyLeaves);
    } else if (childCollabNode instanceof CollabTextNode && $isTextNode(nextChildNode)) {
      childCollabNode.syncPropertiesAndTextFromLexical(binding, nextChildNode, prevNodeMap);
    } else if (childCollabNode instanceof CollabDecoratorNode && $isDecoratorNode(nextChildNode)) {
      childCollabNode.syncPropertiesFromLexical(binding, nextChildNode, prevNodeMap);
      childCollabNode.syncSlotsFromLexical(binding, nextChildNode, prevNodeMap, dirtyElements, dirtyLeaves);
    }
  }

  // Mirror of the lexical slot map into the `__slots` Y.Map attribute on this
  // element's `_xmlText`. Slots live outside the linked-list children channel,
  // so syncChildrenFromLexical never reaches them; this diff is the local
  // (lexical -> yjs) counterpart of syncSlotsFromYjs. A name gone from lexical
  // is deleted from the Y.Map; a name whose slot node is already serialized at
  // that name is recursed in place (so in-slot content edits propagate); a new
  // or replaced (different node key) name is (re)created and set. The
  // creation-time block in $createCollabNodeFromLexicalNode still seeds slots
  // for a brand-new host (appended via the children diff, which has no matched
  // key to recurse through here).
  syncSlotsFromLexical(binding, nextLexicalNode, prevNodeMap, dirtyElements, dirtyLeaves) {
    $syncSlotsFromLexicalShared(binding, this._xmlText, nextLexicalNode, prevNodeMap, dirtyElements, dirtyLeaves, this);
  }
  syncChildrenFromLexical(binding, nextLexicalNode, prevNodeMap, dirtyElements, dirtyLeaves) {
    const prevLexicalNode = this.getPrevNode(prevNodeMap);
    const prevChildren = prevLexicalNode === null ? [] : $createChildrenArray(prevLexicalNode, prevNodeMap);
    const nextChildren = $createChildrenArray(nextLexicalNode, null);
    const prevEndIndex = prevChildren.length - 1;
    const nextEndIndex = nextChildren.length - 1;
    const collabNodeMap = binding.collabNodeMap;
    let prevChildrenSet;
    let nextChildrenSet;
    let prevIndex = 0;
    let nextIndex = 0;
    // moss-multi patch (T3.S6): the Yjs offset of this._children[nextIndex], kept as the diff walks. append() and
    // splice() rescanned every earlier child for it, so a diff adding n children cost O(n²).
    let offset = 0;
    while (prevIndex <= prevEndIndex && nextIndex <= nextEndIndex) {
      const prevKey = prevChildren[prevIndex];
      const nextKey = nextChildren[nextIndex];
      if (prevKey === nextKey) {
        // Nove move, create or remove
        // moss-multi patch (T3.B13): a child that is the same node as before and not dirty has nothing to sync; syncing
        // every child of the root cost most of each keystroke in a note of 40,000 blocks. An edit below a child marks
        // it dirty; a whole new state shares no nodes with the previous one, and history states never reach here.
        if (dirtyElements.has(nextKey) || dirtyLeaves.has(nextKey) || prevNodeMap.get(nextKey) !== $getNodeByKey(nextKey)) {
          this._syncChildFromLexical(binding, nextIndex, nextKey, prevNodeMap, dirtyElements, dirtyLeaves);
        }
        const synced = this._children[nextIndex];
        offset += synced === undefined ? 0 : synced.getSize();
        prevIndex++;
        nextIndex++;
      } else {
        if (prevChildrenSet === undefined) {
          prevChildrenSet = new Set(prevChildren);
        }
        if (nextChildrenSet === undefined) {
          nextChildrenSet = new Set(nextChildren);
        }
        const nextHasPrevKey = nextChildrenSet.has(prevKey);
        const prevHasNextKey = prevChildrenSet.has(nextKey);
        if (!nextHasPrevKey) {
          // Remove
          this._spliceAt(binding, nextIndex, 1, undefined, offset);
          prevIndex++;
        } else {
          // Create or replace
          const nextChildNode = $getNodeByKeyOrThrow(nextKey);
          const collabNode = $createCollabNodeFromLexicalNode(binding, nextChildNode, this);
          collabNodeMap.set(nextKey, collabNode);
          if (prevHasNextKey) {
            this._spliceAt(binding, nextIndex, 1, collabNode, offset);
            prevIndex++;
            nextIndex++;
          } else {
            this._spliceAt(binding, nextIndex, 0, collabNode, offset);
            nextIndex++;
          }
          offset += collabNode.getSize();
        }
      }
    }
    const appendNewChildren = prevIndex > prevEndIndex;
    const removeOldChildren = nextIndex > nextEndIndex;
    if (appendNewChildren && !removeOldChildren) {
      for (; nextIndex <= nextEndIndex; ++nextIndex) {
        const key = nextChildren[nextIndex];
        const nextChildNode = $getNodeByKeyOrThrow(key);
        const collabNode = $createCollabNodeFromLexicalNode(binding, nextChildNode, this);
        if (nextIndex === this._children.length) {
          this._insertAt(offset, collabNode);
          this._children.push(collabNode);
          offset += collabNode.getSize();
        } else {
          this.append(collabNode);
        }
        collabNodeMap.set(key, collabNode);
      }
    } else if (removeOldChildren && !appendNewChildren) {
      const offsets = [];
      for (let i = nextIndex, at = offset; i < this._children.length; i++) {
        offsets.push(at);
        at += this._children[i].getSize();
      }
      for (let i = this._children.length - 1; i >= nextIndex; i--) {
        this._spliceAt(binding, i, 1, undefined, offsets[i - nextIndex]);
      }
    }
  }
  append(collabNode) {
    const children = this._children;
    const lastChild = children[children.length - 1];
    const offset = lastChild !== undefined ? lastChild.getOffset() + lastChild.getSize() : 0;
    this._insertAt(offset, collabNode);
    this._children.push(collabNode);
  }
  // moss-multi patch (T3.S6): append()'s Yjs insert at a known offset.
  _insertAt(offset, collabNode) {
    const xmlText = this._xmlText;
    if (collabNode instanceof CollabElementNode) {
      xmlText.insertEmbed(offset, collabNode._xmlText);
    } else if (collabNode instanceof CollabTextNode) {
      const map = collabNode._map;
      if (map.parent === null) {
        xmlText.insertEmbed(offset, map);
      }
      xmlText.insert(offset + 1, collabNode._text);
    } else if (collabNode instanceof CollabLineBreakNode) {
      xmlText.insertEmbed(offset, collabNode._map);
    } else if (collabNode instanceof CollabDecoratorNode) {
      xmlText.insertEmbed(offset, collabNode._xmlElem);
    }
  }
  splice(binding, index, delCount, collabNode) {
    const child = this._children[index];
    this._spliceAt(binding, index, delCount, collabNode, child === undefined ? -1 : child.getOffset());
  }
  // moss-multi patch (T3.S6): splice() with the offset of this._children[index] known.
  _spliceAt(binding, index, delCount, collabNode, offset) {
    const children = this._children;
    const child = children[index];
    if (child === undefined) {
      if (collabNode !== undefined) {
        this.append(collabNode);
      }
      return;
    }
    if (!(offset !== -1)) {
      formatDevErrorMessage(`splice: expected offset to be greater than zero`);
    }
    const xmlText = this._xmlText;
    if (delCount !== 0) {
      // Destroy the departing children before the embed is deleted below: a
      // child's slots live on its (about-to-be-detached) `_xmlText`, which
      // reads back empty once the embed is gone, so destroy() can only reach
      // them while the child is still attached.
      const childrenToDelete = children.slice(index, index + delCount);
      for (let i = 0; i < childrenToDelete.length; i++) {
        childrenToDelete[i].destroy(binding);
      }

      // What if we delete many nodes, don't we need to get all their
      // sizes?
      xmlText.delete(offset, child.getSize());
    }
    if (collabNode instanceof CollabElementNode) {
      xmlText.insertEmbed(offset, collabNode._xmlText);
    } else if (collabNode instanceof CollabTextNode) {
      const map = collabNode._map;
      if (map.parent === null) {
        xmlText.insertEmbed(offset, map);
      }
      xmlText.insert(offset + 1, collabNode._text);
    } else if (collabNode instanceof CollabLineBreakNode) {
      xmlText.insertEmbed(offset, collabNode._map);
    } else if (collabNode instanceof CollabDecoratorNode) {
      xmlText.insertEmbed(offset, collabNode._xmlElem);
    }
    if (collabNode !== undefined) {
      children.splice(index, delCount, collabNode);
    } else {
      children.splice(index, delCount);
    }
  }
  getChildOffset(collabNode) {
    let offset = 0;
    const children = this._children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child === collabNode) {
        return offset;
      }
      offset += child.getSize();
    }
    return -1;
  }
  destroy(binding) {
    const collabNodeMap = binding.collabNodeMap;
    const children = this._children;
    for (let i = 0; i < children.length; i++) {
      children[i].destroy(binding);
    }

    // Slots live outside the linked-list children channel, so destroying the
    // children above never reaches them. Destroy each slot's collab node too;
    // otherwise it dangles in binding.collabNodeMap after the host is removed.
    // The host's `_xmlText` must still be attached here for SLOTS_ATTR_KEY to read
    // back (its caller — splice — destroys before detaching the embed).
    $destroySlotsShared(binding, this._xmlText);
    if (collabNodeMap.get(this._key) === this) {
      collabNodeMap.delete(this._key);
    }
  }
}
// moss-multi patch (T3.B31a): collab nodes are recorded through the binding's `collabNodesByType`.
function $createCollabElementNode(xmlText, parent, type, collabNodesByType) {
  const collabNode = new CollabElementNode(xmlText, parent, type);
  collabNodesByType.set(xmlText, collabNode);
  return collabNode;
}

// Stores mappings between Yjs shared types and the Lexical nodes they were last associated with.
class CollabV2Mapping {
  _nodeMap = new Map();
  _sharedTypeToNodeKeys = new Map();
  _nodeKeyToSharedType = new Map();
  set(sharedType, node) {
    const isArray = node instanceof Array;

    // Clear all existing associations for this key.
    this.delete(sharedType);

    // If nodes were associated with other shared types, remove those associations.
    const nodes = isArray ? node : [node];
    for (const n of nodes) {
      const key = n.getKey();
      if (this._nodeKeyToSharedType.has(key)) {
        const otherSharedType = this._nodeKeyToSharedType.get(key);
        const keyIndex = this._sharedTypeToNodeKeys.get(otherSharedType).indexOf(key);
        if (keyIndex !== -1) {
          this._sharedTypeToNodeKeys.get(otherSharedType).splice(keyIndex, 1);
        }
        this._nodeKeyToSharedType.delete(key);
        this._nodeMap.delete(key);
      }
    }
    if (sharedType instanceof XmlText) {
      if (!isArray) {
        formatDevErrorMessage(`Text nodes must be mapped as an array`);
      }
      if (node.length === 0) {
        return;
      }
      this._sharedTypeToNodeKeys.set(sharedType, node.map(n => n.getKey()));
      for (const n of node) {
        this._nodeMap.set(n.getKey(), n);
        this._nodeKeyToSharedType.set(n.getKey(), sharedType);
      }
    } else {
      if (!!isArray) {
        formatDevErrorMessage(`Element nodes must be mapped as a single node`);
      }
      if (!!$isTextNode(node)) {
        formatDevErrorMessage(`Text nodes must be mapped to XmlText`);
      }
      this._sharedTypeToNodeKeys.set(sharedType, [node.getKey()]);
      this._nodeMap.set(node.getKey(), node);
      this._nodeKeyToSharedType.set(node.getKey(), sharedType);
    }
  }
  get(sharedType) {
    const nodes = this._sharedTypeToNodeKeys.get(sharedType);
    if (nodes === undefined) {
      return undefined;
    }
    if (sharedType instanceof XmlText) {
      const arr = Array.from(nodes.map(nodeKey => this._nodeMap.get(nodeKey)));
      return arr.length > 0 ? arr : undefined;
    }
    return this._nodeMap.get(nodes[0]);
  }
  getSharedType(node) {
    return this._nodeKeyToSharedType.get(node.getKey());
  }
  delete(sharedType) {
    const nodeKeys = this._sharedTypeToNodeKeys.get(sharedType);
    if (nodeKeys === undefined) {
      return;
    }
    for (const nodeKey of nodeKeys) {
      this._nodeMap.delete(nodeKey);
      this._nodeKeyToSharedType.delete(nodeKey);
    }
    this._sharedTypeToNodeKeys.delete(sharedType);
  }
  deleteNode(nodeKey) {
    const sharedType = this._nodeKeyToSharedType.get(nodeKey);
    if (sharedType) {
      this.delete(sharedType);
    }
    this._nodeMap.delete(nodeKey);
  }
  has(sharedType) {
    return this._sharedTypeToNodeKeys.has(sharedType);
  }
  clear() {
    this._nodeMap.clear();
    this._sharedTypeToNodeKeys.clear();
    this._nodeKeyToSharedType.clear();
  }
}

function createBaseBinding(editor, id, doc, docMap, excludedProperties) {
  const binding = {
    clientID: doc.clientID,
    cursorHighlightSheet: null,
    cursors: new Map(),
    cursorsContainer: null,
    doc,
    docMap,
    editor,
    excludedProperties: excludedProperties || new Map(),
    id,
    nodeProperties: new Map()
  };
  initializeNodeProperties(binding);
  return binding;
}

// moss-multi patch (T3.B31a): upstream's record of a type's collab node, a property on the type.
const TYPE_TAGS = {
  get: sharedType => sharedType._collabNode,
  set: (sharedType, collabNode) => {
    sharedType._collabNode = collabNode;
  }
};

/** Options for {@link createYjsBinding}. */

/**
 * Create a V1 Yjs {@link Binding} that connects a {@link LexicalEditor} to a
 * Yjs `Doc` for real-time collaboration.
 *
 * For the legacy positional-argument API, see {@link createBinding}.
 */
function createYjsBinding({
  editor,
  id,
  doc,
  docMap,
  excludedProperties,
  rootName = 'root',
  ownTypeMap = false
}) {
  const rootXmlText = doc.get(rootName, XmlText);
  // moss-multi patch (T3.B31a): with `ownTypeMap`, the binding keeps its own map from Yjs types to collab nodes and never
  // tags a type (`_collabNode`), so a second binding (a server export reading a live doc in place) writes nothing to the
  // doc or to another binding. Otherwise it tags the types, as upstream does, which costs no table per type.
  const collabNodesByType = ownTypeMap ? new WeakMap() : TYPE_TAGS;
  const root = $createCollabElementNode(rootXmlText, null, 'root', collabNodesByType);
  root._key = 'root';
  return {
    ...createBaseBinding(editor, id, doc, docMap, excludedProperties),
    collabNodeMap: new Map(),
    collabNodesByType,
    root
  };
}
function createBinding(editor, provider, id, doc, docMap, excludedProperties) {
  if (!(doc !== undefined && doc !== null)) {
    formatDevErrorMessage(`createBinding: doc is null or undefined`);
  }
  return createYjsBinding({
    doc,
    docMap,
    editor,
    excludedProperties,
    id
  });
}
function createBindingV2__EXPERIMENTAL(editor, id, doc, docMap, options = {}) {
  if (!(doc !== undefined && doc !== null)) {
    formatDevErrorMessage(`createBinding: doc is null or undefined`);
  }
  const {
    excludedProperties,
    rootName = 'root-v2'
  } = options;
  return {
    ...createBaseBinding(editor, id, doc, docMap, excludedProperties),
    mapping: new CollabV2Mapping(),
    root: doc.get(rootName, XmlElement)
  };
}
function isBindingV1(binding) {
  return Object.prototype.hasOwnProperty.call(binding, 'collabNodeMap');
}

// Mirrors the file-local alias used in CollabElementNode / CollabDecoratorNode.

// @experimental named-slots. Slots are a structural channel separate from the
// linked-list children (excluded from the auto property->attribute path via the
// sets below) and live under this reserved attribute key. The key reuses the
// host's `__slots` field name on purpose: '$' can't prefix it ('$' breaks
// XmlElement.toDOM), and node properties sync under their `__`-prefixed name, so
// reusing `__slots` lets the single `__slots` exclusion below stand in for both
// the field (the Map never auto-syncs as a property) and the channel (its Y.Map
// is never restored as a property). A user field literally named `slots` (no
// `__`) keeps syncing — only the framework's `__slots` is reserved.
const SLOTS_ATTR_KEY = '__slots';
const baseExcludedProperties = new Set(['__key', '__parent', '__next', '__prev', '__state', '__slotHost',
// `__slots` lives on the base LexicalNode (an ElementNode or DecoratorNode can
// host slots), so it is excluded for every node type, not just elements —
// otherwise a decorator host's `__slots` Map leaks into the property->attribute
// sync. It is also `SLOTS_ATTR_KEY` (the slots channel reuses the field name),
// so this one entry doubles as the channel reservation: the channel's Y.Map is
// never restored as a node property in either sync version.
'__slots']);
const elementExcludedProperties = new Set(['__first', '__last', '__size']);
const rootExcludedProperties = new Set(['__cachedText']);
const textExcludedProperties = new Set(['__text']);

// @experimental named-slots. Writes the slots Y.Map onto a host shared type.
// yjs types an XmlElement attribute value as string (its default KV), so a
// nested Y.Map value needs a cast; isolated here — the single, encapsulated
// cast — instead of repeated at each host call. Generic over the Y.Map's value
// type because `Y.Map<T>` is invariant, so the V1 (`YMap<unknown>`) and V2
// (`YMap<XmlElement>`) callers can't share a single non-generic parameter.
function setSlotsAttr(sharedType, slotsY) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedType.setAttribute(SLOTS_ATTR_KEY, slotsY);
}

// @experimental named-slots. Mirrors the reserved-name invariant in core's
// $setSlot. Slot names arrive peer-controlled through the slots Y.Map, so a
// reserved name must be skipped during reconcile rather than allowed to reach
// $setSlot, whose invariant would throw inside the observer editor.update.
function isReservedSlotName(name) {
  return name === '__proto__' || name === 'constructor' || name === 'prototype';
}

// @experimental named-slots. Mirrors the value invariant in core's $setSlot (a
// slot value is any non-inline ElementNode or DecoratorNode — the slot link
// itself is the shadow boundary), so a peer-controlled value can be validated
// during reconcile rather than allowed to reach $setSlot, whose invariant
// would throw inside the observer editor.update.
function $isSlotValueNode(node) {
  return ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();
}
function isExcludedProperty(name, node, binding) {
  if (baseExcludedProperties.has(name) || typeof node[name] === 'function') {
    return true;
  }
  if ($isTextNode(node)) {
    if (textExcludedProperties.has(name)) {
      return true;
    }
  } else if ($isElementNode(node)) {
    if (elementExcludedProperties.has(name) || $isRootNode(node) && rootExcludedProperties.has(name)) {
      return true;
    }
  }
  const nodeKlass = node.constructor;
  const excludedProperties = binding.excludedProperties.get(nodeKlass);
  return excludedProperties != null && excludedProperties.has(name);
}
function initializeNodeProperties(binding) {
  const {
    editor,
    nodeProperties
  } = binding;
  editor.update(() => {
    editor._nodes.forEach(nodeInfo => {
      const node = new nodeInfo.klass();
      const defaultProperties = {};
      for (const [property, value] of Object.entries(node)) {
        if (!isExcludedProperty(property, node, binding)) {
          defaultProperties[property] = value;
        }
      }
      nodeProperties.set(node.__type, Object.freeze(defaultProperties));
    });
  });
}
function getDefaultNodeProperties(node, binding) {
  const type = node.__type;
  const {
    nodeProperties
  } = binding;
  const properties = nodeProperties.get(type);
  if (!(properties !== undefined)) {
    formatDevErrorMessage(`Node properties for ${type} not initialized for sync`);
  }
  return properties;
}

// @experimental named-slots. Syncs one slot value's content (lexical -> yjs),
// dispatching on the collab/lexical node pair. Shared by element and decorator
// hosts; the CollabTextNode branch is inert for a decorator host, where a slot
// value is always a shadow-root element or non-inline decorator, never text.
function $syncSlotContentFromLexical(binding, slotCollab, slotNode, prevNodeMap, dirtyElements, dirtyLeaves) {
  if (slotCollab instanceof CollabElementNode && $isElementNode(slotNode)) {
    slotCollab.syncPropertiesFromLexical(binding, slotNode, prevNodeMap);
    slotCollab.syncChildrenFromLexical(binding, slotNode, prevNodeMap, dirtyElements, dirtyLeaves);
    slotCollab.syncSlotsFromLexical(binding, slotNode, prevNodeMap, dirtyElements, dirtyLeaves);
  } else if (slotCollab instanceof CollabTextNode && $isTextNode(slotNode)) {
    slotCollab.syncPropertiesAndTextFromLexical(binding, slotNode, prevNodeMap);
  } else if (slotCollab instanceof CollabDecoratorNode && $isDecoratorNode(slotNode)) {
    slotCollab.syncPropertiesFromLexical(binding, slotNode, prevNodeMap);
    slotCollab.syncSlotsFromLexical(binding, slotNode, prevNodeMap, dirtyElements, dirtyLeaves);
  }
}

// @experimental named-slots. Seeds a freshly created host's slots Y.Map. Both
// element (xmlText) and decorator (xmlElem) hosts reach this through the create
// path, where no matched key exists for syncSlotsFromLexical to recurse through,
// so each slot value's collab node is built and registered here.
function $seedHostSlots(binding, lexicalNode, hostCollab, sharedType) {
  const slotNames = $getSlotNames(lexicalNode);
  // A class that declares its slots opts into eager map creation: attaching
  // the (possibly empty) Y.Map while the host itself is being created makes
  // every later set — including each name's first — an entry-level Y.Map
  // operation that merges per-key, instead of racing on attribute-level LWW
  // when two clients create the map concurrently.
  const declaresSlots = getDeclaredSlots(lexicalNode.constructor).length > 0;
  if (slotNames.length === 0 && !declaresSlots) {
    return;
  }
  const slotsY = new Map$1();
  let hasSlot = false;
  for (const name of slotNames) {
    const slotNode = $getSlot(lexicalNode, name);
    if (slotNode === null) {
      continue;
    }
    const slotCollab = $createCollabNodeFromLexicalNode(binding, slotNode, hostCollab);
    binding.collabNodeMap.set(slotNode.__key, slotCollab);
    slotsY.set(name, slotCollab.getSharedType());
    hasSlot = true;
  }
  if (hasSlot || declaresSlots) {
    setSlotsAttr(sharedType, slotsY);
  }
}
function $createCollabNodeFromLexicalNode(binding, lexicalNode,
// A slot value (element or decorator) can be parented to a decorator host, so
// the parent is not necessarily an element.
parent) {
  const nodeType = lexicalNode.__type;
  let collabNode;
  if ($isElementNode(lexicalNode)) {
    const xmlText = new XmlText();
    collabNode = $createCollabElementNode(xmlText, parent, nodeType, binding.collabNodesByType);
    collabNode.syncPropertiesFromLexical(binding, lexicalNode, null);
    collabNode.syncChildrenFromLexical(binding, lexicalNode, null, null, null);
    $seedHostSlots(binding, lexicalNode, collabNode, xmlText);
  } else if ($isTextNode(lexicalNode)) {
    // Text and linebreak nodes can never be named-slot values, so their parent
    // is always a collab element node.
    if (!(parent instanceof CollabElementNode)) {
      formatDevErrorMessage(`Expected parent of a text node to be a collab element node`);
    } // TODO create a token text node for token, segmented nodes.
    const map = new Map$1();
    collabNode = $createCollabTextNode(map, lexicalNode.__text, parent, nodeType, binding.collabNodesByType);
    collabNode.syncPropertiesAndTextFromLexical(binding, lexicalNode, null);
  } else if ($isLineBreakNode(lexicalNode)) {
    if (!(parent instanceof CollabElementNode)) {
      formatDevErrorMessage(`Expected parent of a linebreak node to be a collab element node`);
    }
    const map = new Map$1();
    map.set('__type', 'linebreak');
    collabNode = $createCollabLineBreakNode(map, parent, binding.collabNodesByType);
  } else if ($isDecoratorNode(lexicalNode)) {
    const xmlElem = new XmlElement();
    collabNode = $createCollabDecoratorNode(xmlElem, parent, nodeType, binding.collabNodesByType);
    collabNode.syncPropertiesFromLexical(binding, lexicalNode, null);
    $seedHostSlots(binding, lexicalNode, collabNode, xmlElem);
  } else {
    {
      formatDevErrorMessage(`Expected text, element, decorator, or linebreak node`);
    }
  }
  collabNode._key = lexicalNode.__key;
  return collabNode;
}
function getNodeTypeFromSharedType(sharedType) {
  const type = sharedTypeGet(sharedType, '__type');
  if (!(typeof type === 'string' || typeof type === 'undefined')) {
    formatDevErrorMessage(`Expected shared type to include type attribute`);
  }
  return type;
}

// A decorator host stores its named slots as a `__slots` Y.Map attribute on its
// `_xmlElem`. A decorator may only parent a node that is genuinely one of its
// slot values; this confirms that relationship so the parent invariant below
// stays tight (a non-slot node mis-parented to a decorator is still rejected,
// and decorators have no children channel, so this is the only legitimate way a
// decorator becomes a parent).
function decoratorHostsSlotSharedType(parent, sharedType) {
  const slotsY = parent._xmlElem.getAttribute(SLOTS_ATTR_KEY);
  if (!(slotsY instanceof Map$1)) {
    return false;
  }
  for (const value of slotsY.values()) {
    if (value === sharedType) {
      return true;
    }
  }
  return false;
}
function $getOrInitCollabNodeFromSharedType(binding, sharedType, parent) {
  const collabNode = binding.collabNodesByType.get(sharedType);
  if (collabNode === undefined) {
    const registeredNodes = binding.editor._nodes;
    const type = getNodeTypeFromSharedType(sharedType);
    if (!(typeof type === 'string')) {
      formatDevErrorMessage(`Expected shared type to include type attribute`);
    }
    const nodeInfo = registeredNodes.get(type);
    if (!(nodeInfo !== undefined)) {
      formatDevErrorMessage(`Node ${type} is not registered`);
    }
    const sharedParent = sharedType.parent;
    const targetParent = parent === undefined && sharedParent !== null ? $getOrInitCollabNodeFromSharedType(binding, sharedParent) : parent || null;
    if (!(targetParent instanceof CollabElementNode || targetParent instanceof CollabDecoratorNode && decoratorHostsSlotSharedType(targetParent, sharedType))) {
      formatDevErrorMessage(`Expected parent to be a collab element node, or a collab decorator node hosting this shared type as a named slot`);
    }
    if (sharedType instanceof XmlText) {
      return $createCollabElementNode(sharedType, targetParent, type, binding.collabNodesByType);
    } else if (sharedType instanceof Map$1) {
      // Text and linebreak nodes can never be named-slot values (setSlot only
      // accepts non-inline elements/decorators), so their parent is always a
      // collab element node — a decorator parent here would be a bug.
      if (!(targetParent instanceof CollabElementNode)) {
        formatDevErrorMessage(`Expected parent of a text or linebreak node to be a collab element node`);
      }
      if (type === 'linebreak') {
        return $createCollabLineBreakNode(sharedType, targetParent, binding.collabNodesByType);
      }
      return $createCollabTextNode(sharedType, '', targetParent, type, binding.collabNodesByType);
    } else if (sharedType instanceof XmlElement) {
      return $createCollabDecoratorNode(sharedType, targetParent, type, binding.collabNodesByType);
    }
  }
  return collabNode;
}
function createLexicalNodeFromCollabNode(binding, collabNode, parentKey) {
  const type = collabNode.getType();
  const registeredNodes = binding.editor._nodes;
  const nodeInfo = registeredNodes.get(type);
  if (!(nodeInfo !== undefined)) {
    formatDevErrorMessage(`Node ${type} is not registered`);
  }
  const lexicalNode = new nodeInfo.klass();
  lexicalNode.__parent = parentKey;
  collabNode._key = lexicalNode.__key;
  if (collabNode instanceof CollabElementNode) {
    const xmlText = collabNode._xmlText;
    collabNode.syncPropertiesFromYjs(binding, null);
    collabNode.applyChildrenYjsDelta(binding, xmlText.toDelta());
    collabNode.syncChildrenFromYjs(binding);
  } else if (collabNode instanceof CollabTextNode) {
    collabNode.syncPropertiesAndTextFromYjs(binding, null);
  } else if (collabNode instanceof CollabDecoratorNode) {
    collabNode.syncPropertiesFromYjs(binding, null);
    if (!$isDecoratorNode(lexicalNode)) {
      formatDevErrorMessage(`Expected a decorator node for a collab decorator node`);
    }
    collabNode.syncSlotsFromYjs(binding, lexicalNode);
  }
  binding.collabNodeMap.set(lexicalNode.__key, collabNode);
  return lexicalNode;
}
function $syncPropertiesFromYjs(binding, sharedType, lexicalNode, keysChanged) {
  const properties = keysChanged === null ? sharedType instanceof Map$1 ? Array.from(sharedType.keys()) : sharedType instanceof XmlText || sharedType instanceof XmlElement ? Object.keys(sharedType.getAttributes()) : Object.keys(sharedType) : Array.from(keysChanged);
  let writableNode;
  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];
    if (isExcludedProperty(property, lexicalNode, binding)) {
      if (property === '__state' && isBindingV1(binding)) {
        if (!writableNode) {
          writableNode = lexicalNode.getWritable();
        }
        $syncNodeStateToLexical(sharedType, writableNode);
      }
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevValue = lexicalNode[property];
    let nextValue = sharedTypeGet(sharedType, property);
    if (prevValue !== nextValue) {
      if (nextValue instanceof Doc) {
        const yjsDocMap = binding.docMap;
        if (prevValue instanceof Doc) {
          yjsDocMap.delete(prevValue.guid);
        }
        const key = nextValue.guid;
        yjsDocMap.set(key, nextValue);

        // If the node already constructed a nested editor (e.g. via
        // buildEditorFromExtensions in its constructor), reuse it so its
        // extensions and LexicalBuilder registration survive the sync.
        // Otherwise, fall back to a bare editor.
        if (isLexicalEditor(prevValue)) {
          prevValue._key = key;
          nextValue = prevValue;
        } else {
          const nestedEditor = createEditor();
          nestedEditor._key = key;
          nextValue = nestedEditor;
        }
      }
      if (writableNode === undefined) {
        writableNode = lexicalNode.getWritable();
      }
      writableNode[property] =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nextValue;
    }
  }
}
function sharedTypeGet(sharedType, property) {
  if (sharedType instanceof Map$1) {
    return sharedType.get(property);
  } else if (sharedType instanceof XmlText || sharedType instanceof XmlElement) {
    return sharedType.getAttribute(property);
  } else {
    return sharedType[property];
  }
}
function sharedTypeSet(sharedType, property, nextValue) {
  if (sharedType instanceof Map$1) {
    sharedType.set(property, nextValue);
  } else {
    sharedType.setAttribute(property, nextValue);
  }
}
function $syncNodeStateToLexical(sharedType, lexicalNode) {
  const existingState = sharedTypeGet(sharedType, '__state');
  if (!(existingState instanceof Map$1)) {
    return;
  }
  // This should only called when creating the node initially,
  // incremental updates to state come in through YMapEvent
  // with the __state as the target.
  $getWritableNodeState(lexicalNode).updateFromJSON(existingState.toJSON());
}
function syncNodeStateFromLexical(binding, sharedType, prevLexicalNode, nextLexicalNode) {
  const nextState = nextLexicalNode.__state;
  // Reading from a shared type that hasn't been integrated into a doc yet
  // logs a "premature access" warning in yjs >= 13.6.10. When the shared
  // type is detached we know there cannot be any existing state.
  const existingState = sharedType.doc === null ? undefined : sharedTypeGet(sharedType, '__state');
  if (!nextState) {
    return;
  }
  const [unknown, known] = nextState.getInternalState();
  const prevState = prevLexicalNode && prevLexicalNode.__state;
  const stateMap = existingState instanceof Map$1 ? existingState : new Map$1();
  if (prevState === nextState) {
    return;
  }
  const [prevUnknown, prevKnown] = prevState && stateMap.doc ? prevState.getInternalState() : [undefined, new Map()];
  if (unknown) {
    for (const [k, v] of Object.entries(unknown)) {
      if (prevUnknown && v !== prevUnknown[k]) {
        stateMap.set(k, v);
      }
    }
  }
  for (const [stateConfig, v] of known) {
    if (prevKnown.get(stateConfig) !== v) {
      stateMap.set(stateConfig.key, stateConfig.unparse(v));
    }
  }
  if (!existingState) {
    sharedTypeSet(sharedType, '__state', stateMap);
  }
}
function syncPropertiesFromLexical(binding, sharedType, prevLexicalNode, nextLexicalNode) {
  const properties = Object.keys(getDefaultNodeProperties(nextLexicalNode, binding));
  const EditorClass = binding.editor.constructor;
  syncNodeStateFromLexical(binding, sharedType, prevLexicalNode, nextLexicalNode);
  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];
    const prevValue =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prevLexicalNode === null ? undefined : prevLexicalNode[property];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nextValue = nextLexicalNode[property];
    if (prevValue !== nextValue) {
      if (nextValue instanceof EditorClass) {
        const yjsDocMap = binding.docMap;
        let prevDoc;
        if (prevValue instanceof EditorClass) {
          const prevKey = prevValue._key;
          prevDoc = yjsDocMap.get(prevKey);
          yjsDocMap.delete(prevKey);
        }

        // If we already have a document, use it.
        const doc = prevDoc || new Doc();
        const key = doc.guid;
        nextValue._key = key;
        yjsDocMap.set(key, doc);
        nextValue = doc;
        // Mark the node dirty as we've assigned a new key to it
        binding.editor.update(() => {
          nextLexicalNode.markDirty();
        });
      }
      sharedTypeSet(sharedType, property, nextValue);
    }
  }
}
function spliceString(str, index, delCount, newText) {
  return str.slice(0, index) + newText + str.slice(index + delCount);
}
// moss-multi patch (T3.S6): the scan can start at child `startIndex`, whose offset is `startOffset`; `start` in the
// result is the offset of the child at `nodeIndex`.
function getPositionFromElementAndOffset(node, offset, boundaryIsEdge, startIndex = 0, startOffset = 0) {
  let index = startOffset;
  let i = startIndex;
  const children = node._children;
  const childrenLength = children.length;
  for (; i < childrenLength; i++) {
    const child = children[i];
    const childOffset = index;
    const size = child.getSize();
    index += size;
    const exceedsBoundary = boundaryIsEdge ? index >= offset : index > offset;
    if (exceedsBoundary && child instanceof CollabTextNode) {
      let textOffset = offset - childOffset - 1;
      if (textOffset < 0) {
        textOffset = 0;
      }
      const diffLength = index - offset;
      return {
        length: diffLength,
        node: child,
        nodeIndex: i,
        offset: textOffset,
        start: childOffset
      };
    }
    if (index > offset) {
      return {
        length: 0,
        node: child,
        nodeIndex: i,
        offset: childOffset,
        start: childOffset
      };
    } else if (i === childrenLength - 1) {
      return {
        length: 0,
        node: null,
        nodeIndex: i + 1,
        offset: childOffset + 1,
        start: index
      };
    }
  }
  return {
    length: 0,
    node: null,
    nodeIndex: 0,
    offset: 0,
    start: 0
  };
}
function doesSelectionNeedRecovering(selection) {
  const anchor = selection.anchor;
  const focus = selection.focus;
  let recoveryNeeded = false;
  try {
    const anchorNode = anchor.getNode();
    const focusNode = focus.getNode();
    if (
    // We might have removed a node that no longer exists
    !anchorNode.isAttached() || !focusNode.isAttached() ||
    // If we've split a node, then the offset might not be right
    $isTextNode(anchorNode) && anchor.offset > anchorNode.getTextContentSize() || $isTextNode(focusNode) && focus.offset > focusNode.getTextContentSize()) {
      recoveryNeeded = true;
    }
  } catch (_e) {
    // Sometimes checking nor a node via getNode might trigger
    // an error, so we need recovery then too.
    recoveryNeeded = true;
  }
  return recoveryNeeded;
}
function syncWithTransaction(binding, fn) {
  binding.doc.transact(fn, binding);
}
function $moveSelectionToPreviousNode(anchorNodeKey, currentEditorState) {
  // moss-multi patch (T3.S6): a loop, not recursion; undoing a large paste removes thousands of siblings at once.
  for (let key = anchorNodeKey;;) {
    const anchorNode = currentEditorState._nodeMap.get(key);
    if (!anchorNode) {
      $getRoot().selectStart();
      return;
    }
    const prevNodeKey = anchorNode.__prev;
    let prevNode = null;
    if (prevNodeKey) {
      prevNode = $getNodeByKey(prevNodeKey);
    }
    if (prevNode === null && anchorNode.__parent !== null) {
      prevNode = $getNodeByKey(anchorNode.__parent);
    }
    if (prevNode === null) {
      $getRoot().selectStart();
      return;
    }
    if (prevNode.isAttached()) {
      prevNode.selectEnd();
      return;
    }
    key = prevNode.__key;
  }
}

// Slot reconcile shared by CollabElementNode + CollabDecoratorNode. The two
// paths differ only in where the slot map rides — the element host keeps it
// on `_xmlText`, the decorator host on `_xmlElem` — and in the lexical
// host's type. The reconcile logic itself (drop slots missing from yjs, set
// slots present in yjs) is identical, so keeping it in one place avoids the
// risk of one path drifting from the other.
//
// `slotsParent` is the yjs node carrying the `__slots` Y.Map attribute (the
// host's `_xmlText` for element hosts, `_xmlElem` for decorator hosts).
// `ownerCollab` is the collab host that owns the slot map; it's passed to
// `$getOrInitCollabNodeFromSharedType` so a newly materialized slot collab
// node is parented correctly.
function $syncSlotsFromYjsShared(binding, slotsParent, lexicalNode, ownerCollab) {
  const slotsY = slotsParent.getAttribute(SLOTS_ATTR_KEY);
  const yNames = slotsY instanceof Map$1 ? new Set(slotsY.keys()) : new Set();
  for (const name of $getSlotNames(lexicalNode)) {
    if (!yNames.has(name)) {
      // Mirror children removal (splice -> destroy): drop the departing slot's
      // collab node so its entry doesn't dangle in binding.collabNodeMap. The
      // slot's shared type is already gone from the Y.Map here, so reach the
      // collab node through the lexical key instead of the shared type.
      const slotNode = $getSlot(lexicalNode, name);
      if (slotNode !== null) {
        const slotCollab = binding.collabNodeMap.get(slotNode.__key);
        if (slotCollab !== undefined) {
          slotCollab.destroy(binding);
        }
      }
      $removeSlot(lexicalNode, name);
    }
  }
  if (!(slotsY instanceof Map$1)) {
    return;
  }
  for (const [name, slotSharedType] of slotsY.entries()) {
    // Names and values are peer-controlled. An entry that would trip the
    // invariants of $setSlot or $getOrInitCollabNodeFromSharedType is skipped
    // as a silent no-op (the local doc simply doesn't reflect it) instead of
    // crashing the observer editor.update.
    if (isReservedSlotName(name)) {
      continue;
    }
    if (!(slotSharedType instanceof XmlText || slotSharedType instanceof XmlElement || slotSharedType instanceof Map$1)) {
      continue;
    }
    const existingSlot = $getSlot(lexicalNode, name);
    const existingCollab = existingSlot === null ? undefined : binding.collabNodeMap.get(existingSlot.__key);
    if (existingCollab !== undefined && existingCollab.getSharedType() === slotSharedType) {
      // Same shared type still occupies this name; its own observer syncs
      // the slot's content, so leave the slot in place.
      continue;
    }
    // An uninitialized shared type can only be materialized with a string
    // `__type` ($getOrInitCollabNodeFromSharedType's invariant).
    if (binding.collabNodesByType.get(slotSharedType) === undefined && typeof sharedTypeGet(slotSharedType, '__type') !== 'string') {
      continue;
    }
    // A YMap value can only materialize a text/linebreak node — never a valid
    // slot value — and under a decorator host it would trip the element-parent
    // invariant before the value check below can reject it.
    if (slotSharedType instanceof Map$1 && ownerCollab instanceof CollabDecoratorNode) {
      continue;
    }
    // A cached collab node whose lexical node is live means the shared type
    // already backs a slot (set under an earlier name in this very Y.Map) or
    // an attached node elsewhere; re-materializing it would repoint the collab
    // node away from that node. First name wins; later aliases are skipped.
    const cachedCollab = binding.collabNodesByType.get(slotSharedType);
    if (cachedCollab !== undefined) {
      const cachedNode = $getNodeByKey(cachedCollab._key);
      if (cachedNode !== null && (cachedNode.isAttached() || ($isElementNode(cachedNode) || $isDecoratorNode(cachedNode)) && cachedNode.getLatest().__slotHost !== null)) {
        continue;
      }
    }
    const slotCollab = $getOrInitCollabNodeFromSharedType(binding, slotSharedType, ownerCollab);
    const slotLexicalNode = createLexicalNodeFromCollabNode(binding, slotCollab, null);
    if (!$isSlotValueNode(slotLexicalNode)) {
      // The materialized node can't legally occupy a slot; undo the
      // collabNodeMap registration so the rejected node doesn't dangle (the
      // node itself stays unattached and lexical GCs it).
      if (binding.collabNodeMap.get(slotLexicalNode.__key) === slotCollab) {
        binding.collabNodeMap.delete(slotLexicalNode.__key);
      }
      continue;
    }
    // A different shared type means the slot was replaced remotely. Destroy
    // the departing collab node so it doesn't dangle in binding.collabNodeMap
    // ($setSlot below detaches the stale lexical occupant).
    if (existingCollab !== undefined) {
      existingCollab.destroy(binding);
    }
    $setSlot(lexicalNode, name, slotLexicalNode);
  }
}

// Lexical -> Yjs slot diff shared by CollabElementNode + CollabDecoratorNode.
// Same factoring as `$syncSlotsFromYjsShared`: identical logic, parent only
// differs.
function $syncSlotsFromLexicalShared(binding, slotsParent, nextLexicalNode, prevNodeMap, dirtyElements, dirtyLeaves, ownerCollab) {
  const slotNames = $getSlotNames(nextLexicalNode);
  const existing = slotsParent.getAttribute(SLOTS_ATTR_KEY);
  if (slotNames.length === 0 && !(existing instanceof Map$1)) {
    return;
  }
  let slotsY;
  if (existing instanceof Map$1) {
    slotsY = existing;
  } else {
    slotsY = new Map$1();
    setSlotsAttr(slotsParent, slotsY);
  }
  const nextNames = new Set(slotNames);
  for (const name of Array.from(slotsY.keys())) {
    if (!nextNames.has(name)) {
      // Mirror children removal (splice -> destroy): destroy the slot's collab
      // node before dropping it so its binding.collabNodeMap entry is cleared.
      // A value that was never materialized locally (e.g. skipped as invalid
      // remote data) has no collab node and nothing to destroy.
      const removed = slotsY.get(name);
      const removedCollab = removed == null ? undefined : binding.collabNodesByType.get(removed);
      if (removedCollab !== undefined) {
        removedCollab.destroy(binding);
      }
      slotsY.delete(name);
    }
  }
  const collabNodeMap = binding.collabNodeMap;
  for (const name of slotNames) {
    const slotNode = $getSlot(nextLexicalNode, name);
    if (slotNode === null) {
      continue;
    }
    const slotCollab = collabNodeMap.get(slotNode.__key);
    if (slotCollab !== undefined && slotsY.get(name) === slotCollab.getSharedType()) {
      $syncSlotContentFromLexical(binding, slotCollab, slotNode, prevNodeMap, dirtyElements, dirtyLeaves);
    } else {
      // A same-name replace keeps the name in nextNames, so the removal loop
      // above never destroys the departing value. Mirror children removal
      // here too: destroy the previous slot's collab node before overwriting
      // its Y.Map entry so its binding.collabNodeMap entry doesn't dangle. A
      // value never materialized locally has no collab node to destroy.
      const prev = slotsY.get(name);
      const prevCollab = prev == null ? undefined : binding.collabNodesByType.get(prev);
      if (prevCollab !== undefined) {
        prevCollab.destroy(binding);
      }
      const created = $createCollabNodeFromLexicalNode(binding, slotNode, ownerCollab);
      collabNodeMap.set(slotNode.__key, created);
      slotsY.set(name, created.getSharedType());
    }
  }
}

// Slot cleanup shared by host destroy paths.
function $destroySlotsShared(binding, slotsParent) {
  const slotsY = slotsParent.getAttribute(SLOTS_ATTR_KEY);
  if (slotsY instanceof Map$1) {
    for (const name of slotsY.keys()) {
      // A value never materialized locally (e.g. skipped as invalid remote
      // data) has no collab node and nothing to destroy.
      const slot = slotsY.get(name);
      const slotCollab = slot == null ? undefined : binding.collabNodesByType.get(slot);
      if (slotCollab !== undefined) {
        slotCollab.destroy(binding);
      }
    }
  }
}

// https://docs.yjs.dev/api/shared-types/y.xmlelement
// "Define a top-level type; Note that the nodeName is always "undefined""
const isRootElement = el => el.nodeName === 'UNDEFINED';
const $createOrUpdateNodeFromYElement = (el, binding, keysChanged, childListChanged, snapshot, prevSnapshot, computeYChange) => {
  let node = binding.mapping.get(el);
  if (node && keysChanged && keysChanged.size === 0 && !childListChanged) {
    return node;
  }
  const type = isRootElement(el) ? RootNode.getType() : el.nodeName;
  const registeredNodes = binding.editor._nodes;
  const nodeInfo = registeredNodes.get(type);
  if (nodeInfo === undefined) {
    throw new Error(`$createOrUpdateNodeFromYElement: Node ${type} is not registered`);
  }
  if (!node) {
    node = new nodeInfo.klass();
    keysChanged = null;
    childListChanged = true;
  }
  if (childListChanged && node instanceof ElementNode) {
    const children = [];
    const $createChildren = childType => {
      if (childType instanceof XmlElement) {
        const n = $createOrUpdateNodeFromYElement(childType, binding, new Set(), false, snapshot, prevSnapshot, computeYChange);
        if (n !== null) {
          children.push(n);
        }
      } else if (childType instanceof XmlText) {
        const ns = $createOrUpdateTextNodesFromYText(childType, binding, snapshot, prevSnapshot, computeYChange);
        if (ns !== null) {
          ns.forEach(textchild => {
            if (textchild !== null) {
              children.push(textchild);
            }
          });
        }
      } else {
        {
          formatDevErrorMessage(`XmlHook is not supported`);
        }
      }
    };
    if (snapshot === undefined || prevSnapshot === undefined) {
      el.toArray().forEach($createChildren);
    } else {
      typeListToArraySnapshot(el, new Snapshot(prevSnapshot.ds, snapshot.sv)).filter(childType => !childType._item.deleted || isItemVisible(childType._item, snapshot) || isItemVisible(childType._item, prevSnapshot)).forEach($createChildren);
    }
    $spliceChildren(node, children);
  }

  // TODO(collab-v2): typing for XmlElement generic
  const attrs = el.getAttributes(snapshot);
  if (!isRootElement(el) && snapshot !== undefined) {
    if (!isItemVisible(el._item, snapshot)) {
      attrs[stateKeyToAttrKey('ychange')] = computeYChange ? computeYChange('removed', el._item.id) : {
        type: 'removed'
      };
    } else if (!isItemVisible(el._item, prevSnapshot)) {
      attrs[stateKeyToAttrKey('ychange')] = computeYChange ? computeYChange('added', el._item.id) : {
        type: 'added'
      };
    }
  }
  const properties = {
    ...getDefaultNodeProperties(node, binding)
  };
  const state = {};
  for (const k in attrs) {
    if (k.startsWith(STATE_KEY_PREFIX)) {
      // State keys route through NodeState.updateFromJSON, which guards
      // against prototype-polluting keys.
      state[attrKeyToStateKey(k)] = attrs[k];
    } else if (k !== SLOTS_ATTR_KEY && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
      // Skip prototype-polluting property keys from untrusted remote attrs.
      // SLOTS_ATTR_KEY is a dedicated channel restored below, not a node property.
      properties[k] = attrs[k];
    }
  }
  $syncPropertiesFromYjs(binding, properties, node, keysChanged);
  if (!keysChanged) {
    $getWritableNodeState(node).updateFromJSON(state);
  } else if (keysChanged.size > 0) {
    const writableState = $getWritableNodeState(node);
    for (const changedKey of keysChanged) {
      if (changedKey.startsWith(STATE_KEY_PREFIX)) {
        const stateKey = attrKeyToStateKey(changedKey);
        writableState.updateFromUnknown(stateKey, state[stateKey]);
      }
    }
  }

  // Reconcile the dedicated `__slots` channel against the host's `__slots` Y.Map.
  // Diff (not blind $setSlot) so unchanged entries don't churn writables on
  // every remote reconcile ($setSlot has move semantics, so a re-set is safe
  // but not free). A
  // host is an ElementNode or a non-inline DecoratorNode; both store slots as a
  // `__slots` Y.Map attribute, and the reconcile only uses base-node slot methods.
  if (node instanceof ElementNode || $isDecoratorNode(node)) {
    // SLOTS_ATTR_KEY is stored as a Y.Map attribute; `attrs` widens it to unknown so
    // instanceof can narrow it back, and is already snapshot-aware, so a
    // historical render sees the membership the snapshot had.
    const slotsY = attrs[SLOTS_ATTR_KEY];
    const yNames = new Set();
    if (slotsY instanceof Map$1) {
      // The Y.Map's entries live in its own item chain, not the host's, so
      // the snapshot read needs typeMapGetAllSnapshot (entries() is live).
      const slotEntries = snapshot === undefined ? Array.from(slotsY.entries()) : Object.entries(typeMapGetAllSnapshot(slotsY, snapshot));
      for (const [name, slotType] of slotEntries) {
        yNames.add(name);
        // Names and values are peer-controlled. An entry that would trip
        // $setSlot's invariants is skipped as a silent no-op (the local doc
        // simply doesn't reflect it) instead of crashing the observer
        // editor.update.
        if (isReservedSlotName(name)) {
          continue;
        }
        let slotNode = null;
        if (slotType instanceof XmlElement) {
          slotNode = $createOrUpdateNodeFromYElement(slotType, binding, new Set(), false, snapshot, prevSnapshot, computeYChange);
        }
        if (slotNode === null) {
          continue;
        }
        // Same node already occupies this slot -> its content was updated in
        // place by the calls above, so skip $setSlot (which would re-fire its
        // invariant). A different (or absent) key means a fresh/replaced node;
        // $setSlot detaches the previous occupant.
        const existingSlot = $getSlot(node, name);
        if (existingSlot !== null && existingSlot.getKey() === slotNode.getKey()) {
          continue;
        }
        if (!$isSlotValueNode(slotNode)) {
          // A node materialized only for this rejected entry is dropped from
          // the mapping (it stays unattached and lexical GCs it, so a stale
          // entry would later dereference a dead node); an attached node
          // legitimately mapped elsewhere keeps its mapping.
          if (!slotNode.isAttached()) {
            $deleteMappingForSubtree(slotType, binding);
          }
          continue;
        }
        if (slotNode.getLatest().__slotHost !== null) {
          // Already slotted: the same shared type under two names. First name
          // wins; later aliases are skipped.
          continue;
        }
        $setSlot(node, name, slotNode);
      }
    }
    // Drop slots that no longer exist in yjs. getSlotNames returns a snapshot
    // array, so mutating __slots via $removeSlot during iteration is safe.
    for (const name of $getSlotNames(node)) {
      if (!yNames.has(name)) {
        $removeSlot(node, name);
      }
    }
  }
  const latestNode = node.getLatest();
  binding.mapping.set(el, latestNode);
  return latestNode;
};
const $spliceChildren = (node, nextChildren) => {
  const prevChildren = node.getChildren();
  const prevChildrenKeySet = new Set(prevChildren.map(child => child.getKey()));
  const nextChildrenKeySet = new Set(nextChildren.map(child => child.getKey()));
  const prevEndIndex = prevChildren.length - 1;
  const nextEndIndex = nextChildren.length - 1;
  let prevIndex = 0;
  let nextIndex = 0;
  while (prevIndex <= prevEndIndex && nextIndex <= nextEndIndex) {
    const prevKey = prevChildren[prevIndex].getKey();
    const nextKey = nextChildren[nextIndex].getKey();
    if (prevKey === nextKey) {
      prevIndex++;
      nextIndex++;
      continue;
    }
    const nextHasPrevKey = nextChildrenKeySet.has(prevKey);
    const prevHasNextKey = prevChildrenKeySet.has(nextKey);
    if (!nextHasPrevKey) {
      // If removing the last node, insert remaining new nodes immediately, otherwise if the node
      // cannot be empty, it will remove itself from its parent.
      if (nextIndex === 0 && node.getChildrenSize() === 1) {
        node.splice(nextIndex, 1, nextChildren.slice(nextIndex));
        return;
      }
      // Remove
      node.splice(nextIndex, 1, []);
      prevIndex++;
      continue;
    }

    // Create or replace
    const nextChildNode = nextChildren[nextIndex];
    if (prevHasNextKey) {
      node.splice(nextIndex, 1, [nextChildNode]);
      prevIndex++;
      nextIndex++;
    } else {
      node.splice(nextIndex, 0, [nextChildNode]);
      nextIndex++;
    }
  }
  const appendNewChildren = prevIndex > prevEndIndex;
  const removeOldChildren = nextIndex > nextEndIndex;
  if (appendNewChildren && !removeOldChildren) {
    node.append(...nextChildren.slice(nextIndex));
  } else if (removeOldChildren && !appendNewChildren) {
    node.splice(nextChildren.length, node.getChildrenSize() - nextChildren.length, []);
  }
};
const isItemVisible = (item, snapshot) => snapshot === undefined ? !item.deleted : snapshot.sv.has(item.id.client) && snapshot.sv.get(item.id.client) > item.id.clock && !isDeleted(snapshot.ds, item.id);
const $createOrUpdateTextNodesFromYText = (text, binding, snapshot, prevSnapshot, computeYChange) => {
  const deltas = toDelta(text, snapshot, prevSnapshot, computeYChange);

  // Use existing text nodes if the count and types all align, otherwise throw out the existing
  // nodes and create new ones.
  let nodes = binding.mapping.get(text) ?? [];
  const nodeTypes = deltas.map(delta => delta.attributes.t ?? TextNode.getType());
  const canReuseNodes = nodes.length === nodeTypes.length && nodes.every((node, i) => node.getType() === nodeTypes[i]);
  if (!canReuseNodes) {
    const registeredNodes = binding.editor._nodes;
    nodes = nodeTypes.map(type => {
      const nodeInfo = registeredNodes.get(type);
      if (nodeInfo === undefined) {
        throw new Error(`$createTextNodesFromYText: Node ${type} is not registered`);
      }
      const node = new nodeInfo.klass();
      if (!$isTextNode(node)) {
        throw new Error(`$createTextNodesFromYText: Node ${type} is not a TextNode`);
      }
      return node;
    });
  }

  // Sync text, properties and state to the text nodes.
  for (let i = 0; i < deltas.length; i++) {
    const node = nodes[i];
    const delta = deltas[i];
    const {
      attributes,
      insert
    } = delta;
    if (node.__text !== insert) {
      node.setTextContent(insert);
    }
    const properties = {
      ...getDefaultNodeProperties(node, binding),
      ...attributes.p
    };
    const state = Object.fromEntries(Object.entries(attributes).filter(([k]) => k.startsWith(STATE_KEY_PREFIX)).map(([k, v]) => [attrKeyToStateKey(k), v]));
    $syncPropertiesFromYjs(binding, properties, node, null);
    $getWritableNodeState(node).updateFromJSON(state);
  }
  const latestNodes = nodes.map(node => node.getLatest());
  binding.mapping.set(text, latestNodes);
  return latestNodes;
};
const $createTypeFromTextNodes = (nodes, binding) => {
  const type = new XmlText();
  $updateYText(type, nodes, binding);
  return type;
};

// Build a `Y.Map<name, XmlElement>` mirroring the host's `__slots`. Each slot
// root is a non-inline ElementNode or DecoratorNode (enforced by $setSlot), so
// it is serialized through `createTypeFromElementNode` and nested slots fold in
// recursively. Returns undefined for a host with no slots so non-slot hosts
// set no attribute — except that a class declaring its slots gets the (empty)
// Y.Map eagerly at creation, mirroring V1's $seedHostSlots: the map then
// merges with host creation itself, so each name's FIRST set is an
// entry-level Y.Map operation instead of an attribute-level LWW race between
// clients that both create the map.
const $createSlotsYType = (node, binding) => {
  const names = $getSlotNames(node);
  if (names.length === 0 && getDeclaredSlots(node.constructor).length === 0) {
    return undefined;
  }
  const slotsY = new Map$1();
  for (const name of names) {
    const slotNode = $getSlot(node, name);
    if (slotNode == null) {
      continue;
    }
    slotsY.set(name, $createSlotValueType(slotNode, binding));
  }
  return slotsY;
};

// Recursive cleanup of binding.mapping entries for a yjs subtree. When a slot
// is dropped or replaced, only its top-level shared type was deleted from
// binding.mapping; the slot's nested children (text spans, descendant
// elements, nested slots) stayed registered and leaked because the slot's
// Y.Doc parent was already gone, so the yjs delete event never re-fired
// observers down the subtree.
const $deleteMappingForSubtree = (type, binding) => {
  // XmlHook is never registered in binding.mapping (SharedType =
  // XmlElement | XmlText), so only delete for those two.
  if (type instanceof XmlElement || type instanceof XmlText) {
    binding.mapping.delete(type);
  }
  if (type instanceof XmlElement) {
    const slotsY = type.getAttribute(SLOTS_ATTR_KEY);
    if (slotsY instanceof Map$1) {
      for (const slot of slotsY.values()) {
        $deleteMappingForSubtree(slot, binding);
      }
    }
    for (const child of type.toArray()) {
      $deleteMappingForSubtree(child, binding);
    }
  }
};

// Per-slot diff of the host's `__slots` against its `__slots` Y.Map, applied in
// place during a host update (the lexical->yjs counterpart of the yjs->lexical
// slot reconcile in $createOrUpdateNodeFromYElement). Names gone from lexical
// are deleted; a slot whose node identity is preserved is recursed via
// $updateYFragment only when dirty (so in-slot edits propagate while unchanged
// slots keep their yjs IDs instead of being recreated); a new or replaced slot
// is (re)created. The creation-time path (createTypeFromElementNode) still seeds
// slots for a freshly inserted host.
const $updateSlotsYType = (yDomFragment, node, binding, dirtyElements, y) => {
  const names = $getSlotNames(node);
  const existing = yDomFragment.getAttribute(SLOTS_ATTR_KEY);

  // Removing the last slot empties the Y.Map but keeps the attribute
  // (mirrors V1): removing it would re-open the first-set creation race for
  // the next add and destroy concurrent adds. $equalSlots treats an empty map
  // and an absent attribute alike. A class that declares its slots opts into
  // eager creation — the map is attached even before the first set, so each
  // name's first set merges per-entry instead of racing on attribute LWW.
  if (names.length === 0 && !(existing instanceof Map$1) && getDeclaredSlots(node.constructor).length === 0) {
    return;
  }
  let slotsY;
  if (existing instanceof Map$1) {
    slotsY = existing;
  } else {
    slotsY = new Map$1();
    setSlotsAttr(yDomFragment, slotsY);
  }
  const nextNames = new Set(names);
  for (const name of Array.from(slotsY.keys())) {
    if (!nextNames.has(name)) {
      const removed = slotsY.get(name);
      if (removed !== undefined) {
        $deleteMappingForSubtree(removed, binding);
      }
      slotsY.delete(name);
    }
  }
  for (const name of names) {
    const slotNode = $getSlot(node, name);
    if (slotNode == null) {
      continue;
    }
    const slotY = slotsY.get(name);
    if (slotY instanceof XmlElement && (slotNode instanceof ElementNode || $isDecoratorNode(slotNode)) && slotY === binding.mapping.getSharedType(slotNode)) {
      if (dirtyElements.has(slotNode.getKey())) {
        $updateYFragment(y, slotY, slotNode, binding, dirtyElements);
      }
    } else {
      if (slotY instanceof XmlElement) {
        $deleteMappingForSubtree(slotY, binding);
      }
      slotsY.set(name, $createSlotValueType(slotNode, binding));
    }
  }
};
const $createTypeFromElementNode = (node, binding) => {
  const type = new XmlElement(node.getType());
  const attrs = {
    ...propertiesToAttributes(node, binding),
    ...stateToAttributes(node)
  };
  for (const key in attrs) {
    const val = attrs[key];
    if (val !== null) {
      // TODO(collab-v2): typing for XmlElement generic
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type.setAttribute(key, val);
    }
  }
  // A non-inline DecoratorNode can host named slots too. It has no children
  // channel, so build only the slots and map the host (so its later in-place
  // slot update can find it). A plain decorator with no slots stays unmapped, as
  // before.
  if (!(node instanceof ElementNode)) {
    const decoratorSlotsY = $createSlotsYType(node, binding);
    if (decoratorSlotsY !== undefined) {
      setSlotsAttr(type, decoratorSlotsY);
      binding.mapping.set(type, node);
    }
    return type;
  }
  const slotsY = $createSlotsYType(node, binding);
  if (slotsY !== undefined) {
    setSlotsAttr(type, slotsY);
  }
  type.insert(0, normalizeNodeContent(node).map(n => $createTypeFromTextOrElementNode(n, binding)));
  binding.mapping.set(type, node);
  return type;
};

// Slot values are diffed by node identity in $updateSlotsYType, so every slot
// value must be mapped to keep its yjs id across host updates.
// createTypeFromElementNode maps ElementNodes and slot-hosting decorators but
// leaves a plain decorator unmapped (it has nothing to diff in place as a
// child); as a slot value it still needs the mapping, so add it here.
const $createSlotValueType = (slotNode, binding) => {
  const type = $createTypeFromElementNode(slotNode, binding);
  if ($isDecoratorNode(slotNode) && binding.mapping.getSharedType(slotNode) === undefined) {
    binding.mapping.set(type, slotNode);
  }
  return type;
};
const $createTypeFromTextOrElementNode = (node, meta) => node instanceof Array ? $createTypeFromTextNodes(node, meta) : $createTypeFromElementNode(node, meta);
const isObject = val => typeof val === 'object' && val != null;
const equalAttrs = (pattrs, yattrs) => {
  const keys = Object.keys(pattrs).filter(key => pattrs[key] !== null);
  if (yattrs == null) {
    return keys.length === 0;
  }
  let eq = keys.length === Object.keys(yattrs).filter(key => yattrs[key] !== null).length;
  for (let i = 0; i < keys.length && eq; i++) {
    const key = keys[i];
    const l = pattrs[key];
    const r = yattrs[key];
    eq = key === 'ychange' || l === r || isObject(l) && isObject(r) && equalAttrs(l, r);
  }
  return eq;
};
const normalizeNodeContent = node => {
  if (!(node instanceof ElementNode)) {
    return [];
  }
  const c = node.getChildren();
  const res = [];
  for (let i = 0; i < c.length; i++) {
    const n = c[i];
    if ($isTextNode(n)) {
      const textNodes = [];
      for (let maybeTextNode = c[i]; i < c.length && $isTextNode(maybeTextNode); maybeTextNode = c[++i]) {
        textNodes.push(maybeTextNode);
      }
      i--;
      res.push(textNodes);
    } else {
      res.push(n);
    }
  }
  return res;
};
const equalYTextLText = (ytext, ltexts, binding) => {
  const deltas = toDelta(ytext);
  return deltas.length === ltexts.length && deltas.every((d, i) => {
    const ltext = ltexts[i];
    const type = d.attributes.t ?? TextNode.getType();
    const propertyAttrs = d.attributes.p ?? {};
    const stateAttrs = Object.fromEntries(Object.entries(d.attributes).filter(([k]) => k.startsWith(STATE_KEY_PREFIX)));
    return d.insert === ltext.getTextContent() && type === ltext.getType() && equalAttrs(propertyAttrs, propertiesToAttributes(ltext, binding)) && equalAttrs(stateAttrs, stateToAttributes(ltext));
  });
};

// Slots half of $equalYTypePNode: the `__slots` attribute is excluded from the
// plain attribute comparison (it is a dedicated channel, not a node property),
// so the equality scan would otherwise repoint the mapping without recursing
// and a slot diff would never be written to yjs. An absent attribute and an
// empty Y.Map are both equal to an empty lexical slot map ($updateSlotsYType
// keeps the map once created). A name whose yjs shared type doesn't map to the
// lexical slot node is reported unequal — a false negative costs a recursion,
// not correctness.
const $equalSlots = (ytype, lnode, binding) => {
  const names = $getSlotNames(lnode);
  const slotsY = ytype.getAttribute(SLOTS_ATTR_KEY);
  if (!(slotsY instanceof Map$1)) {
    return names.length === 0;
  }
  if (slotsY.size !== names.length) {
    return false;
  }
  for (const name of names) {
    const slotNode = $getSlot(lnode, name);
    const slotY = slotsY.get(name);
    if (slotNode === null || !(slotY instanceof XmlElement) || binding.mapping.get(slotY) !== slotNode) {
      return false;
    }
  }
  return true;
};
const $equalYTypePNode = (ytype, lnode, binding) => {
  if (ytype instanceof XmlElement && !(lnode instanceof Array) && matchNodeName(ytype, lnode)) {
    const normalizedContent = normalizeNodeContent(lnode);
    // SLOTS_ATTR_KEY is a dedicated channel compared by $equalSlots, never a node
    // property; leaving it in would make every slotted host compare unequal.
    const yattrs = ytype.getAttributes();
    delete yattrs[SLOTS_ATTR_KEY];
    return ytype._length === normalizedContent.length && equalAttrs(yattrs, {
      ...propertiesToAttributes(lnode, binding),
      ...stateToAttributes(lnode)
    }) && $equalSlots(ytype, lnode, binding) && ytype.toArray().every((ychild, i) => $equalYTypePNode(ychild, normalizedContent[i], binding));
  }
  return ytype instanceof XmlText && lnode instanceof Array && equalYTextLText(ytype, lnode, binding);
};
const mappedIdentity = (mapped, lcontent) => mapped === lcontent || mapped instanceof Array && lcontent instanceof Array && mapped.length === lcontent.length && mapped.every((a, i) => lcontent[i] === a);
const $computeChildEqualityFactor = (ytype, lnode, binding) => {
  const yChildren = ytype.toArray();
  const pChildren = normalizeNodeContent(lnode);
  const pChildCnt = pChildren.length;
  const yChildCnt = yChildren.length;
  const minCnt = Math.min(yChildCnt, pChildCnt);
  let left = 0;
  let right = 0;
  let foundMappedChild = false;
  for (; left < minCnt; left++) {
    const leftY = yChildren[left];
    const leftP = pChildren[left];
    if (leftY instanceof XmlHook) {
      break;
    } else if (mappedIdentity(binding.mapping.get(leftY), leftP)) {
      foundMappedChild = true; // definite (good) match!
    } else if (!$equalYTypePNode(leftY, leftP, binding)) {
      break;
    }
  }
  for (; left + right < minCnt; right++) {
    const rightY = yChildren[yChildCnt - right - 1];
    const rightP = pChildren[pChildCnt - right - 1];
    if (rightY instanceof XmlHook) {
      break;
    } else if (mappedIdentity(binding.mapping.get(rightY), rightP)) {
      foundMappedChild = true;
    } else if (!$equalYTypePNode(rightY, rightP, binding)) {
      break;
    }
  }
  return {
    equalityFactor: left + right,
    foundMappedChild
  };
};
const ytextTrans = ytext => {
  let str = '';
  let n = ytext._start;
  const nAttrs = {};
  while (n !== null) {
    if (!n.deleted) {
      if (n.countable && n.content instanceof ContentString) {
        str += n.content.str;
      } else if (n.content instanceof ContentFormat) {
        nAttrs[n.content.key] = null;
      }
    }
    n = n.right;
  }
  return {
    nAttrs,
    str
  };
};
const $updateYText = (ytext, ltexts, binding) => {
  binding.mapping.set(ytext, ltexts);
  const {
    nAttrs,
    str
  } = ytextTrans(ytext);
  const content = ltexts.map((node, i) => {
    const nodeType = node.getType();
    let p = propertiesToAttributes(node, binding);
    if (Object.keys(p).length === 0) {
      p = null;
    }
    return {
      attributes: Object.assign({}, nAttrs, {
        ...(nodeType !== TextNode.getType() && {
          t: nodeType
        }),
        p,
        ...stateToAttributes(node),
        ...(i > 0 && {
          i
        }) // Prevent Yjs from merging text nodes itself.
      }),
      insert: node.getTextContent(),
      nodeKey: node.getKey()
    };
  });
  const nextText = content.map(c => c.insert).join('');
  const selection = $getSelection();
  let cursorOffset;
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    cursorOffset = 0;
    for (const c of content) {
      if (c.nodeKey === selection.anchor.key) {
        cursorOffset += selection.anchor.offset;
        break;
      }
      cursorOffset += c.insert.length;
    }
  } else {
    cursorOffset = nextText.length;
  }
  const {
    insert,
    remove,
    index
  } = simpleDiffWithCursor(str, nextText, cursorOffset);
  ytext.delete(index, remove);
  ytext.insert(index, insert);
  ytext.applyDelta(content.map(c => ({
    attributes: c.attributes,
    retain: c.insert.length
  })));
};
const toDelta = (ytext, snapshot, prevSnapshot, computeYChange) => {
  return ytext.toDelta(snapshot, prevSnapshot, computeYChange).map(delta => {
    const attributes = delta.attributes ?? {};
    if ('ychange' in attributes) {
      attributes[stateKeyToAttrKey('ychange')] = attributes.ychange;
      delete attributes.ychange;
    }
    return {
      ...delta,
      attributes
    };
  });
};
const propertiesToAttributes = (node, meta) => {
  const defaultProperties = getDefaultNodeProperties(node, meta);
  const attrs = {};
  Object.entries(defaultProperties).forEach(([property, defaultValue]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = node[property];
    if (value !== defaultValue) {
      attrs[property] = value;
    }
  });
  return attrs;
};
const STATE_KEY_PREFIX = 's_';
const stateKeyToAttrKey = key => `s_${key}`;
const attrKeyToStateKey = key => {
  if (!key.startsWith(STATE_KEY_PREFIX)) {
    throw new Error(`Invalid state key: ${key}`);
  }
  return key.slice(STATE_KEY_PREFIX.length);
};
const stateToAttributes = node => {
  const state = node.__state;
  if (!state) {
    return {};
  }
  const [unknown = {}, known] = state.getInternalState();
  const attrs = {};
  for (const [k, v] of Object.entries(unknown)) {
    attrs[stateKeyToAttrKey(k)] = v;
  }
  for (const [stateConfig, v] of known) {
    attrs[stateKeyToAttrKey(stateConfig.key)] = stateConfig.unparse(v);
  }
  return attrs;
};
const $updateYFragment = (y, yDomFragment, node, binding, dirtyElements) => {
  if (yDomFragment instanceof XmlElement && yDomFragment.nodeName !== node.getType() && !(isRootElement(yDomFragment) && node.getType() === RootNode.getType())) {
    throw new Error('node name mismatch!');
  }
  binding.mapping.set(yDomFragment, node);
  // update attributes
  if (yDomFragment instanceof XmlElement) {
    const yDomAttrs = yDomFragment.getAttributes();
    const lexicalAttrs = {
      ...propertiesToAttributes(node, binding),
      ...stateToAttributes(node)
    };
    for (const key in lexicalAttrs) {
      if (lexicalAttrs[key] != null) {
        const isEqual = yDomAttrs[key] === lexicalAttrs[key] ||
        // deep equality check so we don't sync properties/state with object values every update
        isObject(yDomAttrs[key]) && isObject(lexicalAttrs[key]) && equalAttrs(yDomAttrs[key], lexicalAttrs[key]);
        if (!isEqual && key !== 'ychange') {
          // TODO(collab-v2): typing for XmlElement generic
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          yDomFragment.setAttribute(key, lexicalAttrs[key]);
        }
      } else {
        yDomFragment.removeAttribute(key);
      }
    }
    // remove all keys that are no longer in pAttrs. The slots channel is set
    // manually below (not in `lexicalAttrs`), so exclude it here or every
    // update would strip it.
    for (const key in yDomAttrs) {
      if (key !== SLOTS_ATTR_KEY && lexicalAttrs[key] === undefined) {
        yDomFragment.removeAttribute(key);
      }
    }
    // @experimental named-slots. Diff the slots channel in place (preserving
    // the yjs IDs of unchanged slots) rather than rebuilding it wholesale. A
    // non-inline DecoratorNode hosts slots too (it has no children channel).
    if (node instanceof ElementNode || $isDecoratorNode(node)) {
      $updateSlotsYType(yDomFragment, node, binding, dirtyElements, y);
    }
  }
  // update children
  const lChildren = normalizeNodeContent(node);
  const lChildCnt = lChildren.length;
  const yChildren = yDomFragment.toArray();
  const yChildCnt = yChildren.length;
  const minCnt = Math.min(lChildCnt, yChildCnt);
  let left = 0;
  let right = 0;
  // find number of matching elements from left
  for (; left < minCnt; left++) {
    const leftY = yChildren[left];
    const leftL = lChildren[left];
    if (leftY instanceof XmlHook) {
      break;
    } else if (mappedIdentity(binding.mapping.get(leftY), leftL)) {
      // A mapped decorator host (one with slots) needs an in-place update too so
      // its slot channel propagates; only slotted decorators are mapped, so a
      // plain decorator never reaches this branch.
      if (!(leftL instanceof Array) && (leftL instanceof ElementNode || $isDecoratorNode(leftL)) && dirtyElements.has(leftL.getKey())) {
        $updateYFragment(y, leftY, leftL, binding, dirtyElements);
      }
    } else if ($equalYTypePNode(leftY, leftL, binding)) {
      // update mapping
      binding.mapping.set(leftY, leftL);
    } else {
      break;
    }
  }
  // find number of matching elements from right
  for (; right + left < minCnt; right++) {
    const rightY = yChildren[yChildCnt - right - 1];
    const rightL = lChildren[lChildCnt - right - 1];
    if (rightY instanceof XmlHook) {
      break;
    } else if (mappedIdentity(binding.mapping.get(rightY), rightL)) {
      if (!(rightL instanceof Array) && (rightL instanceof ElementNode || $isDecoratorNode(rightL)) && dirtyElements.has(rightL.getKey())) {
        $updateYFragment(y, rightY, rightL, binding, dirtyElements);
      }
    } else if ($equalYTypePNode(rightY, rightL, binding)) {
      // update mapping
      binding.mapping.set(rightY, rightL);
    } else {
      break;
    }
  }
  // try to compare and update
  while (yChildCnt - left - right > 0 && lChildCnt - left - right > 0) {
    const leftY = yChildren[left];
    const leftL = lChildren[left];
    const rightY = yChildren[yChildCnt - right - 1];
    const rightL = lChildren[lChildCnt - right - 1];
    if (leftY instanceof XmlText && leftL instanceof Array) {
      if (!equalYTextLText(leftY, leftL, binding)) {
        $updateYText(leftY, leftL, binding);
      }
      left += 1;
    } else {
      let updateLeft = leftY instanceof XmlElement && matchNodeName(leftY, leftL);
      let updateRight = rightY instanceof XmlElement && matchNodeName(rightY, rightL);
      if (updateLeft && updateRight) {
        // decide which which element to update
        const equalityLeft = $computeChildEqualityFactor(leftY, leftL, binding);
        const equalityRight = $computeChildEqualityFactor(rightY, rightL, binding);
        if (equalityLeft.foundMappedChild && !equalityRight.foundMappedChild) {
          updateRight = false;
        } else if (!equalityLeft.foundMappedChild && equalityRight.foundMappedChild) {
          updateLeft = false;
        } else if (equalityLeft.equalityFactor < equalityRight.equalityFactor) {
          updateLeft = false;
        } else {
          updateRight = false;
        }
      }
      if (updateLeft) {
        $updateYFragment(y, leftY, leftL, binding, dirtyElements);
        left += 1;
      } else if (updateRight) {
        $updateYFragment(y, rightY, rightL, binding, dirtyElements);
        right += 1;
      } else {
        binding.mapping.delete(yDomFragment.get(left));
        yDomFragment.delete(left, 1);
        yDomFragment.insert(left, [$createTypeFromTextOrElementNode(leftL, binding)]);
        left += 1;
      }
    }
  }
  const yDelLen = yChildCnt - left - right;
  if (yChildCnt === 1 && lChildCnt === 0 && yChildren[0] instanceof XmlText) {
    binding.mapping.delete(yChildren[0]);
    // Edge case handling https://github.com/yjs/y-prosemirror/issues/108
    // Only delete the content of the Y.Text to retain remote changes on the same Y.Text object
    yChildren[0].delete(0, yChildren[0].length);
  } else if (yDelLen > 0) {
    yDomFragment.slice(left, left + yDelLen).forEach(type => binding.mapping.delete(type));
    yDomFragment.delete(left, yDelLen);
  }
  if (left + right < lChildCnt) {
    const ins = [];
    for (let i = left; i < lChildCnt - right; i++) {
      ins.push($createTypeFromTextOrElementNode(lChildren[i], binding));
    }
    yDomFragment.insert(left, ins);
  }
};
const matchNodeName = (yElement, lnode) => !(lnode instanceof Array) && yElement.nodeName === lnode.getType();

const STATE_KEY = 'ychange';

// eslint-disable-next-line @typescript-eslint/no-explicit-any

const ychangeState = /* @__PURE__ */createState(STATE_KEY, {
  isEqual: (a, b) => a === b,
  parse: value => value ?? null
});
function $getYChangeState(node) {
  return $getState(node, ychangeState);
}

// Not exposing $setState because it should only be created by SyncV2.ts.

/**
 * Replaces the editor content with a view that compares the state between two given snapshots.
 * Any added or removed nodes between the two snapshots will have {@link YChange} attached to them.
 *
 * @param binding Yjs binding
 * @param snapshot Ending snapshot state (default: current state of the Yjs document)
 * @param prevSnapshot Starting snapshot state (default: empty snapshot)
 */
const renderSnapshot__EXPERIMENTAL = (binding, snapshot$1 = snapshot(binding.doc), prevSnapshot = emptySnapshot) => {
  // The document that contains the full history of this document.
  const {
    doc
  } = binding;
  if (!!doc.gc) {
    formatDevErrorMessage(`GC must be disabled to render snapshot`);
  }
  doc.transact(transaction => {
    // Before rendering, we are going to sanitize ops and split deleted ops
    // if they were deleted by separate users.
    const pud = new PermanentUserData(doc);
    if (pud) {
      pud.dss.forEach(ds => {
        iterateDeletedStructs(transaction, ds, _item => {});
      });
    }
    const computeYChange = (type, id) => {
      const user = type === 'added' ? pud.getUserByClientId(id.client) : pud.getUserByDeletedId(id);
      return {
        id,
        type,
        user: user ?? null
      };
    };
    binding.mapping.clear();
    binding.editor.update(() => {
      $getRoot().clear();
      $createOrUpdateNodeFromYElement(binding.root, binding, null, true, snapshot$1, prevSnapshot, computeYChange);
    });
  }, binding);
};

const SUPPORTS_CSS_HIGHLIGHTS = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS;

/**
 * The subset of a binding that {@link getCursorHighlightSheet} reads. Declared
 * structurally so callers pass a full binding and tests pass a lightweight stub,
 * neither needing a cast.
 *
 * @internal
 */

/**
 * Resolve the per-binding stylesheet that hosts `::highlight(...)` rules,
 * re-adopting it into the editor's current tree scope (document or shadow
 * root) on every call.
 *
 * The editor root can move between the light DOM and a shadow root (a
 * shadow-DOM toggle) without recreating the binding, and `::highlight()` rules
 * only apply in the tree scope that owns the highlighted ranges, so the sheet
 * is re-homed each call. A leftover adoption in a previously-used scope is
 * harmless: shadow encapsulation means a rule there cannot match ranges in the
 * new scope.
 *
 * @internal Exported for tests; not part of the package's public API.
 */
function getCursorHighlightSheet(binding) {
  const rootElement = binding.editor.getRootElement();
  const ownerDocument = getRootOwnerDocument(rootElement);
  let sheet = binding.cursorHighlightSheet;
  if (sheet === null) {
    const view = ownerDocument.defaultView || window;
    sheet = new view.CSSStyleSheet();
    binding.cursorHighlightSheet = sheet;
  }
  const root = rootElement !== null ? rootElement.getRootNode() : null;
  const target = isDOMShadowRoot(root) ? root : ownerDocument;
  if (!target.adoptedStyleSheets.includes(sheet)) {
    target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
  }
  return sheet;
}
function addCursorHighlightRule(binding, highlightName, color) {
  // `color` flows in from peer-controlled awareness state. Reject anything
  // the browser doesn't recognize as a valid <color> so a malicious user can't
  // inject extra declarations through string interpolation below.
  if (!CSS.supports('color', color)) {
    return;
  }
  const sheet = getCursorHighlightSheet(binding);
  const idx = sheet.insertRule(`::highlight(${highlightName}) { }`, sheet.cssRules.length);
  const rule = sheet.cssRules[idx];
  // color-mix because the Highlight API doesn't honor opacity on highlights.
  rule.style.setProperty('background-color', `color-mix(in srgb, ${color} 30%, transparent)`);
  rule.style.setProperty('color', 'inherit');
}
function removeCursorHighlightRule(binding, highlightName) {
  const sheet = binding.cursorHighlightSheet;
  if (sheet === null) {
    return;
  }
  const selector = `::highlight(${highlightName})`;
  for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
    const rule = sheet.cssRules[i];
    // Structural check rather than `instanceof CSSStyleRule`: editors in
    // different frames have their own `CSSStyleRule` constructor.
    if (rule != null && rule.selectorText === selector) {
      sheet.deleteRule(i);
      return;
    }
  }
}
function createRelativePosition(point, binding, assoc = 0) {
  const collabNodeMap = binding.collabNodeMap;
  const collabNode = collabNodeMap.get(point.key);
  if (collabNode === undefined) {
    return null;
  }
  let offset = point.offset;
  let sharedType = collabNode.getSharedType();
  if (collabNode instanceof CollabTextNode) {
    sharedType = collabNode._parent._xmlText;
    const currentOffset = collabNode.getOffset();
    if (currentOffset === -1) {
      return null;
    }
    offset = currentOffset + 1 + offset;
  } else if (collabNode instanceof CollabElementNode && point.type === 'element') {
    const parent = point.getNode();
    if (!$isElementNode(parent)) {
      formatDevErrorMessage(`Element point must be an element node`);
    }
    let accumulatedOffset = 0;
    let i = 0;
    let node = parent.getFirstChild();
    while (node !== null && i++ < offset) {
      if ($isTextNode(node)) {
        accumulatedOffset += node.getTextContentSize() + 1;
      } else {
        accumulatedOffset++;
      }
      node = node.getNextSibling();
    }
    offset = accumulatedOffset;
  }
  return createRelativePositionFromTypeIndex(sharedType, offset, assoc);
}
function createRelativePositionV2(point, binding, assoc = 0) {
  const {
    mapping
  } = binding;
  const {
    offset
  } = point;
  const node = point.getNode();
  const yType = mapping.getSharedType(node);
  if (yType === undefined) {
    return null;
  }
  if (point.type === 'text') {
    if (!$isTextNode(node)) {
      formatDevErrorMessage(`Text point must be a text node`);
    }
    let prevSibling = node.getPreviousSibling();
    let adjustedOffset = offset;
    while ($isTextNode(prevSibling)) {
      adjustedOffset += prevSibling.getTextContentSize();
      prevSibling = prevSibling.getPreviousSibling();
    }
    return createRelativePositionFromTypeIndex(yType, adjustedOffset, assoc);
  } else if (point.type === 'element') {
    if (!$isElementNode(node)) {
      formatDevErrorMessage(`Element point must be an element node`);
    }
    let i = 0;
    let child = node.getFirstChild();
    while (child !== null && i < offset) {
      if ($isTextNode(child)) {
        let nextSibling = child.getNextSibling();
        while ($isTextNode(nextSibling)) {
          nextSibling = nextSibling.getNextSibling();
        }
      }
      i++;
      child = child.getNextSibling();
    }
    return createRelativePositionFromTypeIndex(yType, i, assoc);
  }
  return null;
}
function createAbsolutePosition(relativePosition, binding) {
  return createAbsolutePositionFromRelativePosition(relativePosition, binding.doc);
}
function shouldUpdatePosition(currentPos, pos) {
  if (currentPos == null) {
    if (pos != null) {
      return true;
    }
  } else if (pos == null || !compareRelativePositions(currentPos, pos)) {
    return true;
  }
  return false;
}
function createCursor(name, color) {
  return {
    color: color,
    name: name,
    selection: null
  };
}
function destroySelection(binding, selection) {
  if (selection.highlight !== null) {
    CSS.highlights.delete(selection.highlightName);
    removeCursorHighlightRule(binding, selection.highlightName);
  }
  const cursorsContainer = binding.cursorsContainer;
  if (cursorsContainer === null) {
    return;
  }
  if (selection.caret.parentNode === cursorsContainer) {
    cursorsContainer.removeChild(selection.caret);
  }
  const selections = selection.selections;
  for (let i = 0; i < selections.length; i++) {
    if (selections[i].parentNode === cursorsContainer) {
      cursorsContainer.removeChild(selections[i]);
    }
  }
}
function destroyCursor(binding, cursor) {
  const selection = cursor.selection;
  if (selection !== null) {
    destroySelection(binding, selection);
  }
}
function createCursorSelection(cursor, binding, clientID, anchorKey, anchorOffset, focusKey, focusOffset, selectionHighlight, theme = {}) {
  const color = cursor.color;
  const ownerDocument = getRootOwnerDocument(binding.editor.getRootElement());
  const caret = ownerDocument.createElement('span');
  if (theme.cursor) {
    caret.className = theme.cursor;
    setDOMStyleObject(caret.style, {
      '--lexical-cursor-color': color,
      bottom: '0',
      position: 'absolute',
      right: '-1px',
      top: '0'
    });
  } else {
    setDOMStyleObject(caret.style, {
      'background-color': color,
      bottom: '0',
      position: 'absolute',
      right: '-1px',
      top: '0',
      width: '1px',
      'z-index': '10'
    });
  }
  const name = ownerDocument.createElement('span');
  name.textContent = cursor.name;
  if (theme.cursorName) {
    name.className = theme.cursorName;
  } else {
    setDOMStyleObject(name.style, {
      'background-color': color,
      color: '#fff',
      'font-family': 'Arial',
      'font-size': '12px',
      'font-weight': 'bold',
      left: '-2px',
      'line-height': '12px',
      padding: '2px',
      position: 'absolute',
      top: '-16px',
      'white-space': 'nowrap'
    });
  }
  caret.appendChild(name);

  // CSS.highlights is a document-wide registry, but multiple editors can be
  // mounted in same page.
  const highlightName = `lexical-cursor-${binding.id}-${clientID}`;
  let highlight = null;
  // Opt-in via the plugin's `selectionHighlight` prop. Without it, fall
  // through to the legacy rect-overlay path so existing setups that style
  // `theme.collaboration.selection` keep working.
  if (selectionHighlight && SUPPORTS_CSS_HIGHLIGHTS) {
    highlight = new Highlight();
    CSS.highlights.set(highlightName, highlight);
    addCursorHighlightRule(binding, highlightName, color);
  }
  return {
    anchor: {
      key: anchorKey,
      offset: anchorOffset
    },
    caret,
    color,
    focus: {
      key: focusKey,
      offset: focusOffset
    },
    highlight,
    highlightName,
    name,
    selections: []
  };
}
function updateCursor(binding, cursor, nextSelection, nodeMap, theme = {}) {
  const editor = binding.editor;
  const rootElement = editor.getRootElement();
  const cursorsContainer = binding.cursorsContainer;
  if (cursorsContainer === null || rootElement === null) {
    return;
  }
  const ownerDocument = getRootOwnerDocument(rootElement);
  const cursorsContainerOffsetParent = cursorsContainer.offsetParent;
  if (cursorsContainerOffsetParent === null) {
    return;
  }
  const containerRect = cursorsContainerOffsetParent.getBoundingClientRect();
  const prevSelection = cursor.selection;
  if (nextSelection === null) {
    if (prevSelection === null) {
      return;
    } else {
      cursor.selection = null;
      destroySelection(binding, prevSelection);
      return;
    }
  } else {
    cursor.selection = nextSelection;
  }
  const caret = nextSelection.caret;
  const color = nextSelection.color;
  const highlight = nextSelection.highlight;
  const anchor = nextSelection.anchor;
  const focus = nextSelection.focus;
  const anchorKey = anchor.key;
  const focusKey = focus.key;
  const anchorNode = nodeMap.get(anchorKey);
  const focusNode = nodeMap.get(focusKey);
  if (anchorNode == null || focusNode == null) {
    return;
  }
  if (highlight !== null) {
    // modern path: CSS Custom Highlight API
    const range = createDOMRange(editor, anchorNode, anchor.offset, focusNode, focus.offset);
    if (range === null) {
      return;
    }

    // The browser handles line wrapping, RTL, and font metrics — no rect math.
    highlight.clear();
    if (!range.collapsed) {
      highlight.add(range);
    }

    // Caret stays as a positioned element; anchor it to the focus end.
    const caretRange = range.cloneRange();
    caretRange.collapse(false);
    let caretRect = caretRange.getBoundingClientRect();
    if (caretRect.height === 0 && $isLineBreakNode(focusNode)) {
      // Bare <br>: collapsed range reports zero size. Fall back to the
      // line break's own box so the caret still renders.
      const focusEl = editor.getElementByKey(focusKey);
      if (focusEl !== null) {
        caretRect = focusEl.getBoundingClientRect();
      }
    }
    setDOMStyleObject(caret.style, {
      'background-color': theme.cursor ? '' : color,
      bottom: '',
      height: `${caretRect.height || 16}px`,
      left: `${caretRect.left - containerRect.left}px`,
      'pointer-events': 'none',
      position: 'absolute',
      right: '',
      top: `${caretRect.top - containerRect.top}px`,
      width: '1px',
      'z-index': '10'
    });
    if (caret.parentNode !== cursorsContainer) {
      cursorsContainer.appendChild(caret);
    }
    return;
  }

  // legacy fallback path: per-rect absolutely-positioned span
  const selections = nextSelection.selections;
  let selectionRects;

  // In the case of a collapsed selection on a linebreak, we need
  // to improvise as the browser will return nothing here as <br>
  // apparently take up no visual space :/
  // This won't work in all cases, but it's better than just showing
  // nothing all the time.
  if (anchorNode === focusNode && $isLineBreakNode(anchorNode)) {
    const brRect = editor.getElementByKey(anchorKey).getBoundingClientRect();
    selectionRects = [brRect];
  } else {
    const range = createDOMRange(editor, anchorNode, anchor.offset, focusNode, focus.offset);
    if (range === null) {
      return;
    }
    selectionRects = createRectsFromDOMRange(editor, range);
  }
  const selectionsLength = selections.length;
  const selectionRectsLength = selectionRects.length;
  for (let i = 0; i < selectionRectsLength; i++) {
    const selectionRect = selectionRects[i];
    let selection = selections[i];
    if (selection === undefined) {
      selection = ownerDocument.createElement('span');
      selections[i] = selection;
      const selectionBg = ownerDocument.createElement('span');
      if (theme.selectionBg) {
        selectionBg.className = theme.selectionBg;
      }
      selection.appendChild(selectionBg);
      cursorsContainer.appendChild(selection);
    }
    const top = selectionRect.top - containerRect.top;
    const left = selectionRect.left - containerRect.left;
    const positionStyle = {
      height: `${selectionRect.height}px`,
      left: `${left}px`,
      'pointer-events': 'none',
      position: 'absolute',
      top: `${top}px`,
      width: `${selectionRect.width}px`
    };
    if (theme.selection) {
      selection.className = theme.selection;
      setDOMStyleObject(selection.style, {
        ...positionStyle,
        '--lexical-cursor-color': color
      });
      setDOMStyleObject(selection.firstChild.style, {
        height: '100%',
        left: '0',
        position: 'absolute',
        top: '0',
        width: '100%'
      });
    } else {
      setDOMStyleObject(selection.style, positionStyle);
      setDOMStyleObject(selection.firstChild.style, {
        ...positionStyle,
        'background-color': color,
        left: '0',
        opacity: '0.3',
        top: '0',
        'z-index': '5'
      });
    }
    if (i === selectionRectsLength - 1) {
      if (caret.parentNode !== selection) {
        selection.appendChild(caret);
      }
    }
  }
  for (let i = selectionsLength - 1; i >= selectionRectsLength; i--) {
    const selection = selections[i];
    cursorsContainer.removeChild(selection);
    selections.pop();
  }
}
/**
 * @deprecated Use `$getAnchorAndFocusForUserState` instead.
 */
function getAnchorAndFocusCollabNodesForUserState(binding, userState) {
  const {
    anchorPos,
    focusPos
  } = userState;
  let anchorCollabNode = null;
  let anchorOffset = 0;
  let focusCollabNode = null;
  let focusOffset = 0;
  if (anchorPos !== null && focusPos !== null) {
    const anchorAbsPos = createAbsolutePosition(anchorPos, binding);
    const focusAbsPos = createAbsolutePosition(focusPos, binding);
    if (anchorAbsPos !== null && focusAbsPos !== null) {
      [anchorCollabNode, anchorOffset] = getCollabNodeAndOffset(anchorAbsPos.type, anchorAbsPos.index, binding);
      [focusCollabNode, focusOffset] = getCollabNodeAndOffset(focusAbsPos.type, focusAbsPos.index, binding);
    }
  }
  return {
    anchorCollabNode,
    anchorOffset,
    focusCollabNode,
    focusOffset
  };
}
function $getAnchorAndFocusForUserState(binding, userState) {
  const {
    anchorPos,
    focusPos
  } = userState;
  const anchorAbsPos = anchorPos ? createAbsolutePosition(anchorPos, binding) : null;
  const focusAbsPos = focusPos ? createAbsolutePosition(focusPos, binding) : null;
  if (anchorAbsPos === null || focusAbsPos === null) {
    return {
      anchorKey: null,
      anchorOffset: 0,
      focusKey: null,
      focusOffset: 0
    };
  }
  if (isBindingV1(binding)) {
    const [anchorCollabNode, anchorOffset] = getCollabNodeAndOffset(anchorAbsPos.type, anchorAbsPos.index, binding);
    const [focusCollabNode, focusOffset] = getCollabNodeAndOffset(focusAbsPos.type, focusAbsPos.index, binding);
    return {
      anchorKey: anchorCollabNode !== null ? anchorCollabNode.getKey() : null,
      anchorOffset,
      focusKey: focusCollabNode !== null ? focusCollabNode.getKey() : null,
      focusOffset
    };
  }
  let [anchorNode, anchorOffset] = $getNodeAndOffsetV2(binding.mapping, anchorAbsPos);
  let [focusNode, focusOffset] = $getNodeAndOffsetV2(binding.mapping, focusAbsPos);
  // For a non-collapsed selection, if the start of the selection is as the end of a text node,
  // move it to the beginning of the next text node (if one exists).
  if (focusNode && anchorNode && (focusNode !== anchorNode || focusOffset !== anchorOffset)) {
    const isBackwards = focusNode.isBefore(anchorNode);
    const startNode = isBackwards ? focusNode : anchorNode;
    const startOffset = isBackwards ? focusOffset : anchorOffset;
    if ($isTextNode(startNode) && $isTextNode(startNode.getNextSibling()) && startOffset === startNode.getTextContentSize()) {
      if (isBackwards) {
        focusNode = startNode.getNextSibling();
        focusOffset = 0;
      } else {
        anchorNode = startNode.getNextSibling();
        anchorOffset = 0;
      }
    }
  }
  return {
    anchorKey: anchorNode !== null ? anchorNode.getKey() : null,
    anchorOffset,
    focusKey: focusNode !== null ? focusNode.getKey() : null,
    focusOffset
  };
}
function $syncLocalCursorPosition(binding, provider) {
  const awareness = provider.awareness;
  const localState = awareness.getLocalState();
  if (localState === null) {
    return;
  }
  const {
    anchorKey,
    anchorOffset,
    focusKey,
    focusOffset
  } = $getAnchorAndFocusForUserState(binding, localState);
  if (anchorKey !== null && focusKey !== null) {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }
    $setPoint(selection.anchor, anchorKey, anchorOffset);
    $setPoint(selection.focus, focusKey, focusOffset);
  }
}
function $setPoint(point, key, offset) {
  if (point.key !== key || point.offset !== offset) {
    let anchorNode = $getNodeByKey(key);
    if (anchorNode !== null && !$isElementNode(anchorNode) && !$isTextNode(anchorNode)) {
      const parent = anchorNode.getParentOrThrow();
      key = parent.getKey();
      offset = anchorNode.getIndexWithinParent();
      anchorNode = parent;
    }
    point.set(key, offset, $isElementNode(anchorNode) ? 'element' : 'text');
  }
}
function getCollabNodeAndOffset(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
sharedType, offset, binding) {
  const collabNode = binding.collabNodesByType.get(sharedType);
  if (collabNode === undefined) {
    return [null, 0];
  }
  if (collabNode instanceof CollabElementNode) {
    const {
      node,
      offset: collabNodeOffset
    } = getPositionFromElementAndOffset(collabNode, offset, true);
    if (node === null) {
      return [collabNode, collabNode._children.length];
    } else {
      return [node, collabNodeOffset];
    }
  }
  return [null, 0];
}
function $getNodeAndOffsetV2(mapping, absolutePosition) {
  const yType = absolutePosition.type;
  const yOffset = absolutePosition.index;
  if (yType instanceof XmlElement) {
    const node = mapping.get(yType);
    if (node === undefined) {
      return [null, 0];
    }
    if (!$isElementNode(node)) {
      return [node, yOffset];
    }
    let remainingYOffset = yOffset;
    let lexicalOffset = 0;
    const children = node.getChildren();
    while (remainingYOffset > 0 && lexicalOffset < children.length) {
      const child = children[lexicalOffset];
      remainingYOffset -= 1;
      lexicalOffset += 1;
      if ($isTextNode(child)) {
        while (lexicalOffset < children.length && $isTextNode(children[lexicalOffset])) {
          lexicalOffset += 1;
        }
      }
    }
    return [node, lexicalOffset];
  } else {
    const nodes = mapping.get(yType);
    if (nodes === undefined) {
      return [null, 0];
    }
    let i = 0;
    let adjustedOffset = yOffset;
    while (adjustedOffset > nodes[i].getTextContentSize() && i + 1 < nodes.length) {
      adjustedOffset -= nodes[i].getTextContentSize();
      i++;
    }
    const textNode = nodes[i];
    return [textNode, Math.min(adjustedOffset, textNode.getTextContentSize())];
  }
}
function getAwarenessStatesDefault(_binding, provider) {
  return provider.awareness.getStates();
}
function syncCursorPositions(binding, provider, options) {
  const {
    getAwarenessStates = getAwarenessStatesDefault,
    selectionHighlight = false
  } = options ?? {};
  const awarenessStates = Array.from(getAwarenessStates(binding, provider));
  const localClientID = binding.clientID;
  const cursors = binding.cursors;
  const editor = binding.editor;
  const collabTheme = editor._config.theme.collaboration;
  const nodeMap = editor._editorState._nodeMap;
  const visitedClientIDs = new Set();
  for (let i = 0; i < awarenessStates.length; i++) {
    const awarenessState = awarenessStates[i];
    const [clientID, awareness] = awarenessState;
    if (clientID !== 0 && clientID !== localClientID) {
      visitedClientIDs.add(clientID);
      const {
        name,
        color,
        focusing
      } = awareness;
      let selection = null;
      let cursor = cursors.get(clientID);
      if (cursor === undefined) {
        cursor = createCursor(name, color);
        cursors.set(clientID, cursor);
      }
      if (focusing) {
        const {
          anchorKey,
          anchorOffset,
          focusKey,
          focusOffset
        } = editor.read(() => $getAnchorAndFocusForUserState(binding, awareness));
        if (anchorKey !== null && focusKey !== null) {
          selection = cursor.selection;
          if (selection === null) {
            selection = createCursorSelection(cursor, binding, clientID, anchorKey, anchorOffset, focusKey, focusOffset, selectionHighlight, collabTheme);
          } else {
            const anchor = selection.anchor;
            const focus = selection.focus;
            anchor.key = anchorKey;
            anchor.offset = anchorOffset;
            focus.key = focusKey;
            focus.offset = focusOffset;
          }
        }
      }
      updateCursor(binding, cursor, selection, nodeMap, collabTheme);
    }
  }
  const allClientIDs = Array.from(cursors.keys());
  for (let i = 0; i < allClientIDs.length; i++) {
    const clientID = allClientIDs[i];
    if (!visitedClientIDs.has(clientID)) {
      const cursor = cursors.get(clientID);
      if (cursor !== undefined) {
        destroyCursor(binding, cursor);
        cursors.delete(clientID);
      }
    }
  }
}
function syncLexicalSelectionToYjs(binding, provider, prevSelection, nextSelection) {
  const awareness = provider.awareness;
  const localState = awareness.getLocalState();
  if (localState === null) {
    return;
  }
  const {
    anchorPos: currentAnchorPos,
    focusPos: currentFocusPos,
    name,
    color,
    focusing,
    awarenessData
  } = localState;
  let anchorPos = null;
  let focusPos = null;
  if (nextSelection === null || currentAnchorPos !== null && !nextSelection.is(prevSelection)) {
    if (prevSelection === null) {
      return;
    }
  }
  if ($isRangeSelection(nextSelection)) {
    // For a non-collapsed range, give each endpoint an assoc that sticks it to
    // the character it should track rather than the gap between characters:
    //   left endpoint  (assoc >= 0): anchors to the first selected character,
    //                                so inserts before the selection stay outside.
    //   right endpoint (assoc  < 0): anchors to the last selected character,
    //                                so inserts after the selection stay outside.
    // Collapsed carets keep assoc = 0 on both sides (the default) so the caret
    // naturally follows typing, matching the pre-existing behaviour.
    const isCollapsed = nextSelection.isCollapsed();
    const isBackward = !isCollapsed && nextSelection.isBackward();
    const anchorAssoc = isBackward ? -1 : 0;
    const focusAssoc = !isCollapsed && !isBackward ? -1 : 0;
    if (isBindingV1(binding)) {
      anchorPos = createRelativePosition(nextSelection.anchor, binding, anchorAssoc);
      focusPos = createRelativePosition(nextSelection.focus, binding, focusAssoc);
    } else {
      anchorPos = createRelativePositionV2(nextSelection.anchor, binding, anchorAssoc);
      focusPos = createRelativePositionV2(nextSelection.focus, binding, focusAssoc);
    }
  }
  if (shouldUpdatePosition(currentAnchorPos, anchorPos) || shouldUpdatePosition(currentFocusPos, focusPos)) {
    awareness.setLocalState({
      ...localState,
      anchorPos,
      awarenessData,
      color,
      focusPos,
      focusing,
      name
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function $syncStateEvent(binding, event) {
  const {
    target
  } = event;
  if (!(target._item && target._item.parentSub === '__state' && getNodeTypeFromSharedType(target) === undefined && (target.parent instanceof XmlText || target.parent instanceof XmlElement || target.parent instanceof Map$1))) {
    // TODO there might be a case to handle in here when a YMap
    // is used as a value  of __state? It would probably be desirable
    // to mark the node as dirty when that happens.
    return false;
  }
  const collabNode = $getOrInitCollabNodeFromSharedType(binding, target.parent);
  const node = collabNode.getNode();
  if (node) {
    const state = $getWritableNodeState(node.getWritable());
    for (const k of event.keysChanged) {
      state.updateFromUnknown(k, target.get(k));
    }
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function $syncEvent(binding, event) {
  if (event instanceof YMapEvent && $syncStateEvent(binding, event)) {
    return;
  }
  const {
    target
  } = event;
  // Slots channel: a slot add / delete lands on the host's `__slots` attribute
  // Y.Map (parentSub === SLOTS_ATTR_KEY). An element host stores it on its `_xmlText`,
  // a decorator host on its `_xmlElem` (XmlElement). The Y.Map carries no
  // `__type`, so the default dispatch below would trip the shared-type
  // invariant. Re-route it to a host slot reconcile instead.
  if (event instanceof YMapEvent && target instanceof Map$1 && target._item != null && target._item.parentSub === SLOTS_ATTR_KEY && (target.parent instanceof XmlText || target.parent instanceof XmlElement)) {
    const hostCollab = $getOrInitCollabNodeFromSharedType(binding, target.parent);
    // The two branches are textually identical but stay separate because
    // CollabElementNode and CollabDecoratorNode each typed `syncSlotsFromYjs`
    // against its own lexical-node side (ElementNode vs DecoratorNode); a
    // union narrow at the call site intersects to `never`. A null host node
    // means it was concurrently removed from Lexical; nothing to sync.
    if (hostCollab instanceof CollabElementNode) {
      const hostNode = hostCollab.getNode();
      if (hostNode !== null) {
        hostCollab.syncSlotsFromYjs(binding, hostNode);
      }
    } else if (hostCollab instanceof CollabDecoratorNode) {
      const hostNode = hostCollab.getNode();
      if (hostNode !== null) {
        hostCollab.syncSlotsFromYjs(binding, hostNode);
      }
    }
    return;
  }
  const collabNode = $getOrInitCollabNodeFromSharedType(binding, target);
  if (collabNode instanceof CollabElementNode && event instanceof YTextEvent) {
    // @ts-expect-error We need to access the private childListChanged property of the class
    const {
      keysChanged,
      childListChanged,
      delta
    } = event;

    // Update. SLOTS_ATTR_KEY is a reserved key excluded from property sync; a change
    // to it is handled by the slot reconcile below.
    if (keysChanged.size > 0) {
      collabNode.syncPropertiesFromYjs(binding, keysChanged);
    }

    // A host's first slot set integrates the slots Y.Map in the same
    // transaction that assigns the attribute, so no YMapEvent fires for the
    // (brand-new) map — the change surfaces only as a changed `__slots` key
    // here. The undo of a first set (attribute removed) has the same shape. A
    // null host node means it was concurrently removed; nothing to sync.
    if (keysChanged.has(SLOTS_ATTR_KEY)) {
      const node = collabNode.getNode();
      if (node !== null) {
        collabNode.syncSlotsFromYjs(binding, node);
      }
    }
    if (childListChanged) {
      collabNode.applyChildrenYjsDelta(binding, delta);
      collabNode.syncChildrenFromYjs(binding);
    }
  } else if (collabNode instanceof CollabTextNode && event instanceof YMapEvent) {
    const {
      keysChanged
    } = event;

    // Update
    if (keysChanged.size > 0) {
      collabNode.syncPropertiesAndTextFromYjs(binding, keysChanged);
    }
  } else if (collabNode instanceof CollabDecoratorNode && event instanceof YXmlEvent) {
    const {
      attributesChanged
    } = event;

    // Update. SLOTS_ATTR_KEY is a reserved key excluded from property sync; a change
    // to it is handled by the slot reconcile below.
    if (attributesChanged.size > 0) {
      collabNode.syncPropertiesFromYjs(binding, attributesChanged);
    }

    // Same shape as the element-host case above: a first slot set (or its
    // undo) surfaces only as a changed `__slots` attribute on the host's
    // XmlElement, never as a YMapEvent.
    if (attributesChanged.has(SLOTS_ATTR_KEY)) {
      const node = collabNode.getNode();
      if (node !== null) {
        collabNode.syncSlotsFromYjs(binding, node);
      }
    }
  } else {
    {
      formatDevErrorMessage(`Expected text, element, or decorator event`);
    }
  }
}
function syncYjsChangesToLexical(binding, provider, events, isFromUndoManger, syncCursorPositionsFn = syncCursorPositions) {
  const editor = binding.editor;
  const currentEditorState = editor._editorState;

  // This line precompute the delta before editor update. The reason is
  // delta is computed when it is accessed. Note that this can only be
  // safely computed during the event call. If it is accessed after event
  // call it might result in unexpected behavior.
  // https://github.com/yjs/yjs/blob/00ef472d68545cb260abd35c2de4b3b78719c9e4/src/utils/YEvent.js#L132
  events.forEach(event => event.delta);
  editor.update(() => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      $syncEvent(binding, event);
    }
    $syncCursorFromYjs(currentEditorState, binding, provider);
    if (!isFromUndoManger) {
      // If it is an external change, we don't want the current scroll position to get changed
      // since the user might've intentionally scrolled somewhere else in the document.
      $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
    }
  }, {
    onUpdate: () => {
      syncCursorPositionsFn(binding, provider);
      if (binding.root.isEmpty()) {
        editor.update(() => $ensureEditorNotEmpty());
      }
    },
    skipTransforms: true,
    tag: isFromUndoManger ? HISTORIC_TAG : COLLABORATION_TAG
  });

  // Remove deleted nodes from the collab node map (mirrors the
  // binding.mapping sweep in syncYjsChangesToLexicalV2__EXPERIMENTAL). The
  // destroy paths above can't reach a deleted host's slot values: the host's
  // `__slots` attribute reads back undefined once its shared type is deleted, so
  // without this sweep their entries leak. Double deletes are idempotent.
  if (events.length > 0) {
    const transaction = events[0].transaction;
    iterateDeletedStructs(transaction, transaction.deleteSet, struct => {
      if (struct.constructor === Item) {
        const content = struct.content;
        const type = content.type;
        if (type) {
          const collabNode = binding.collabNodesByType.get(type);
          if (collabNode !== undefined && binding.collabNodeMap.get(collabNode._key) === collabNode) {
            binding.collabNodeMap.delete(collabNode._key);
          }
        }
      }
    });
  }
}
function $syncCursorFromYjs(editorState, binding, provider) {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    if (doesSelectionNeedRecovering(selection)) {
      const prevSelection = editorState._selection;
      if ($isRangeSelection(prevSelection)) {
        $syncLocalCursorPosition(binding, provider);
        if (doesSelectionNeedRecovering(selection)) {
          // If the selected node is deleted, move the selection to the previous or parent node.
          const anchorNodeKey = selection.anchor.key;
          $moveSelectionToPreviousNode(anchorNodeKey, editorState);
        }
      }
      syncLexicalSelectionToYjs(binding, provider, prevSelection, $getSelection());
    } else {
      $syncLocalCursorPosition(binding, provider);
    }
  }
}
function $handleNormalizationMergeConflicts(binding, normalizedNodes) {
  // We handle the merge operations here
  const normalizedNodesKeys = Array.from(normalizedNodes);
  const collabNodeMap = binding.collabNodeMap;
  const mergedNodes = [];
  const removedNodes = [];
  for (let i = 0; i < normalizedNodesKeys.length; i++) {
    const nodeKey = normalizedNodesKeys[i];
    const lexicalNode = $getNodeByKey(nodeKey);
    const collabNode = collabNodeMap.get(nodeKey);
    if (collabNode instanceof CollabTextNode) {
      if ($isTextNode(lexicalNode)) {
        // We mutate the text collab nodes after removing
        // all the dead nodes first, otherwise offsets break.
        mergedNodes.push([collabNode, lexicalNode.__text]);
      } else {
        const offset = collabNode.getOffset();
        if (offset === -1) {
          continue;
        }
        const parent = collabNode._parent;
        collabNode._normalized = true;
        parent._xmlText.delete(offset, 1);
        removedNodes.push(collabNode);
      }
    }
  }
  for (let i = 0; i < removedNodes.length; i++) {
    const collabNode = removedNodes[i];
    const nodeKey = collabNode.getKey();
    collabNodeMap.delete(nodeKey);
    const parentChildren = collabNode._parent._children;
    const index = parentChildren.indexOf(collabNode);
    parentChildren.splice(index, 1);
  }
  for (let i = 0; i < mergedNodes.length; i++) {
    const [collabNode, text] = mergedNodes[i];
    collabNode._text = text;
  }
}

// If there was a collision on the top level paragraph
// we need to re-add a paragraph. To ensure this insertion properly syncs with other clients,
// it must be placed outside of the update block above that has tags 'collaboration' or 'historic'.
function $ensureEditorNotEmpty() {
  if ($getRoot().getChildrenSize() === 0) {
    $getRoot().append($createParagraphNode());
  }
}
function syncLexicalUpdateToYjs(binding, provider, prevEditorState, currEditorState, dirtyElements, dirtyLeaves, normalizedNodes, tags) {
  syncWithTransaction(binding, () => {
    currEditorState.read(() => {
      // We check if the update has come from a origin where the origin
      // was the collaboration binding previously. This can help us
      // prevent unnecessarily re-diffing and possible re-applying
      // the same change editor state again. For example, if a user
      // types a character and we get it, we don't want to then insert
      // the same character again. The exception to this heuristic is
      // when we need to handle normalization merge conflicts.
      if (tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG)) {
        if (normalizedNodes.size > 0) {
          $handleNormalizationMergeConflicts(binding, normalizedNodes);
        }
        return;
      }
      if (dirtyElements.has('root')) {
        const prevNodeMap = prevEditorState._nodeMap;
        const nextLexicalRoot = $getRoot();
        const collabRoot = binding.root;
        collabRoot.syncPropertiesFromLexical(binding, nextLexicalRoot, prevNodeMap);
        collabRoot.syncChildrenFromLexical(binding, nextLexicalRoot, prevNodeMap, dirtyElements, dirtyLeaves);
        // Slots live outside the linked-list children channel, so the root's
        // own slot map needs its dedicated diff too (child hosts get theirs
        // via _syncChildFromLexical).
        collabRoot.syncSlotsFromLexical(binding, nextLexicalRoot, prevNodeMap, dirtyElements, dirtyLeaves);
        // If a local edit emptied the root, schedule recovery outside the
        // collaboration/historic tag so the paragraph syncs back to Yjs.
        // Mirrors the $ensureEditorNotEmpty call in syncYjsChangesToLexical's onUpdate.
        // Only trigger when the previous state had content (prevNodeMap.size > 1 means
        // there were nodes beyond root), so we don't fire on initial empty-editor updates
        // (e.g. a focus update before the editor has been bootstrapped).
        if (nextLexicalRoot.getChildrenSize() === 0 && prevEditorState._nodeMap.size > 1) {
          binding.editor.update(() => $ensureEditorNotEmpty());
        }
      }
      const selection = $getSelection();
      const prevSelection = prevEditorState._selection;
      syncLexicalSelectionToYjs(binding, provider, prevSelection, selection);
    });
  });
}
function $syncEventV2(binding, event) {
  const {
    target
  } = event;
  if (target instanceof XmlElement && event instanceof YXmlEvent) {
    $createOrUpdateNodeFromYElement(target, binding, event.attributesChanged,
    // @ts-expect-error childListChanged is private
    event.childListChanged);
  } else if (target instanceof XmlText && event instanceof YTextEvent) {
    const parent = target.parent;
    if (parent instanceof XmlElement) {
      // Need to sync via parent element in order to attach new next nodes.
      $createOrUpdateNodeFromYElement(parent, binding, new Set(), true);
    } else {
      {
        formatDevErrorMessage(`Expected XmlElement parent for XmlText`);
      }
    }
  } else if (target instanceof Map$1 && event instanceof YMapEvent && target._item != null && target._item.parentSub === SLOTS_ATTR_KEY) {
    // A slot add/remove arrives as a YMapEvent on the host's `__slots` Y.Map.
    // Re-route to the host element so its slots channel gets reconciled. The
    // parentSub guard narrows this branch to the slot Y.Map specifically —
    // other YMap attributes (e.g. `__state` nested maps) reach this dispatch
    // too and must fall through to the default handler.
    const parent = target.parent;
    if (parent instanceof XmlElement) {
      $createOrUpdateNodeFromYElement(parent, binding, new Set([SLOTS_ATTR_KEY]), false);
    } else {
      {
        formatDevErrorMessage(`Expected XmlElement parent for slots Y.Map`);
      }
    }
  } else {
    {
      formatDevErrorMessage(`Expected xml or text event`);
    }
  }
}
function syncYjsChangesToLexicalV2__EXPERIMENTAL(binding, provider, events, transaction, isFromUndoManger) {
  const editor = binding.editor;
  const editorState = editor._editorState;

  // Remove deleted nodes from the mapping
  iterateDeletedStructs(transaction, transaction.deleteSet, struct => {
    if (struct.constructor === Item) {
      const content = struct.content;
      const type = content.type;
      if (type) {
        binding.mapping.delete(type);
      }
    }
  });

  // This line precompute the delta before editor update. The reason is
  // delta is computed when it is accessed. Note that this can only be
  // safely computed during the event call. If it is accessed after event
  // call it might result in unexpected behavior.
  // https://github.com/yjs/yjs/blob/00ef472d68545cb260abd35c2de4b3b78719c9e4/src/utils/YEvent.js#L132
  events.forEach(event => event.delta);
  editor.update(() => {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      $syncEventV2(binding, event);
    }
    $syncCursorFromYjs(editorState, binding, provider);
    if (!isFromUndoManger) {
      // If it is an external change, we don't want the current scroll position to get changed
      // since the user might've intentionally scrolled somewhere else in the document.
      $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
    }
  }, {
    // Need any text node normalization to be synchronously updated back to Yjs, otherwise the
    // binding.mapping will get out of sync.
    discrete: true,
    onUpdate: () => {
      syncCursorPositions(binding, provider);
      if (binding.root.length === 0) {
        editor.update(() => $ensureEditorNotEmpty());
      }
    },
    skipTransforms: true,
    tag: isFromUndoManger ? HISTORIC_TAG : COLLABORATION_TAG
  });
}
function syncYjsStateToLexicalV2__EXPERIMENTAL(binding, provider) {
  binding.mapping.clear();
  const editor = binding.editor;
  editor.update(() => {
    $getRoot().clear();
    $createOrUpdateNodeFromYElement(binding.root, binding, null, true);
    $addUpdateTag(COLLABORATION_TAG);
  }, {
    // Need any text node normalization to be synchronously updated back to Yjs, otherwise the
    // binding.mapping will get out of sync.
    discrete: true,
    onUpdate: () => {
      syncCursorPositions(binding, provider);
      if (binding.root.length === 0) {
        editor.update(() => $ensureEditorNotEmpty());
      }
    },
    skipTransforms: true,
    tag: COLLABORATION_TAG
  });
}
function syncLexicalUpdateToYjsV2__EXPERIMENTAL(binding, provider, prevEditorState, currEditorState, dirtyElements, dirtyLeaves, normalizedNodes, tags) {
  const isFromYjs = tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG);
  if (isFromYjs && normalizedNodes.size === 0) {
    return;
  }

  // Nodes are normalized synchronously (`discrete: true` above), so the mapping may now be
  // incorrect for these nodes, as they point to `getLatest` which is mutable within an update.
  normalizedNodes.forEach(nodeKey => {
    binding.mapping.deleteNode(nodeKey);
  });
  syncWithTransaction(binding, () => {
    currEditorState.read(() => {
      if (dirtyElements.has('root')) {
        const nextLexicalRoot = $getRoot();
        // A DecoratorNode slot value lands in dirtyLeaves (only ElementNodes
        // are routed to dirtyElements), so unioning the two ensures
        // $updateSlotsYType's same-identity recursion gate sees a dirty
        // decorator slot value and propagates its own-attribute changes.
        $updateYFragment(binding.doc, binding.root, nextLexicalRoot, binding, new Set([...dirtyElements.keys(), ...dirtyLeaves]));
        // If a local edit emptied the root, schedule recovery outside the
        // collaboration/historic tag so the paragraph syncs back to Yjs.
        // Mirrors the $ensureEditorNotEmpty call in syncYjsChangesToLexicalV2's onUpdate.
        // Only trigger when the previous state had content (prevNodeMap.size > 1 means
        // there were nodes beyond root), so we don't fire on initial empty-editor updates.
        if (!isFromYjs && nextLexicalRoot.getChildrenSize() === 0 && prevEditorState._nodeMap.size > 1) {
          binding.editor.update(() => $ensureEditorNotEmpty());
        }
      }
      const selection = $getSelection();
      const prevSelection = prevEditorState._selection;
      syncLexicalSelectionToYjs(binding, provider, prevSelection, selection);
    });
  });
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

const CONNECTED_COMMAND = /* @__PURE__ */createCommand('CONNECTED_COMMAND');
const TOGGLE_CONNECT_COMMAND = /* @__PURE__ */createCommand('TOGGLE_CONNECT_COMMAND');
const DIFF_VERSIONS_COMMAND__EXPERIMENTAL = /* @__PURE__ */createCommand('DIFF_VERSIONS_COMMAND');
const CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL = /* @__PURE__ */createCommand('CLEAR_DIFF_VERSIONS_COMMAND');
function createUndoManager(binding, root) {
  return new UndoManager(root, {
    trackedOrigins: new Set([binding, null])
  });
}
function initLocalState(provider, name, color, focusing, awarenessData) {
  provider.awareness.setLocalState({
    anchorPos: null,
    awarenessData,
    color,
    focusPos: null,
    focusing: focusing,
    name
  });
}
function setLocalStateFocus(provider, name, color, focusing, awarenessData) {
  const {
    awareness
  } = provider;
  let localState = awareness.getLocalState();
  if (localState === null) {
    localState = {
      anchorPos: null,
      awarenessData,
      color,
      focusPos: null,
      focusing: focusing,
      name
    };
  }
  localState.focusing = focusing;
  awareness.setLocalState(localState);
}

export { $getAnchorAndFocusForUserState, $getYChangeState, CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL, CONNECTED_COMMAND, DIFF_VERSIONS_COMMAND__EXPERIMENTAL, TOGGLE_CONNECT_COMMAND, createBinding, createBindingV2__EXPERIMENTAL, createUndoManager, createYjsBinding, getAnchorAndFocusCollabNodesForUserState, initLocalState, removeCursorHighlightRule, renderSnapshot__EXPERIMENTAL, setLocalStateFocus, syncCursorPositions, syncLexicalUpdateToYjs, syncLexicalUpdateToYjsV2__EXPERIMENTAL, syncYjsChangesToLexical, syncYjsChangesToLexicalV2__EXPERIMENTAL, syncYjsStateToLexicalV2__EXPERIMENTAL };
