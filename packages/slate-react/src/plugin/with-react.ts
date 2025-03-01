import ReactDOM from 'react-dom'
import { Editor, Node, Path, Operation, Transforms, Range } from 'slate'

import { ReactEditor } from './react-editor'
import { Key } from '../utils/key'
import { EDITOR_TO_ON_CHANGE, NODE_TO_KEY } from '../utils/weak-maps'
import {
  AS_NATIVE,
  NATIVE_OPERATIONS,
  flushNativeEvents,
} from '../utils/native'
import { isDOMText, getPlainText } from '../utils/dom'
import { findCurrentLineRange } from '../utils/lines'

/**
 * `withReact` adds React and DOM specific behaviors to the editor.
 *
 * If you are using TypeScript, you must extend Slate's CustomTypes to use
 * this plugin.
 *
 * See https://docs.slatejs.org/concepts/11-typescript to learn how.
 */

export const withReact = <T extends Editor>(editor: T) => {
  const e = editor as T & ReactEditor
  const { apply, onChange, deleteBackward } = e

  e.deleteBackward = unit => {
    if (unit !== 'line') {
      return deleteBackward(unit)
    }

    if (editor.selection && Range.isCollapsed(editor.selection)) {
      const parentBlockEntry = Editor.above(editor, {
        match: n => Editor.isBlock(editor, n),
        at: editor.selection,
      })

      if (parentBlockEntry) {
        const [, parentBlockPath] = parentBlockEntry
        const parentElementRange = Editor.range(
          editor,
          parentBlockPath,
          editor.selection.anchor
        )

        const currentLineRange = findCurrentLineRange(e, parentElementRange)

        if (!Range.isCollapsed(currentLineRange)) {
          Transforms.delete(editor, { at: currentLineRange })
        }
      }
    }
  }

  e.apply = (op: Operation) => {
    // if we're NOT an insert_text and there's a queue
    // of native events, bail out and flush the queue.
    // otherwise transforms as part of this cycle will
    // be incorrect.
    //
    // This is needed as overriden operations (e.g. `insertText`)
    // can call additional transforms, which will need accurate
    // content, and will be called _before_ `onInput` is fired.
    if (op.type !== 'insert_text') {
      AS_NATIVE.set(editor, false)
      flushNativeEvents(editor)
    }

    // If we're in native mode, queue the operation
    // and it will be applied later.
    if (AS_NATIVE.get(editor)) {
      const nativeOps = NATIVE_OPERATIONS.get(editor)
      if (nativeOps) {
        nativeOps.push(op)
      } else {
        NATIVE_OPERATIONS.set(editor, [op])
      }
      return
    }

    const matches: [Path, Key][] = []

    switch (op.type) {
      case 'insert_text':
      case 'remove_text':
      case 'set_node': {
        for (const [node, path] of Editor.levels(e, { at: op.path })) {
          const key = ReactEditor.findKey(e, node)
          matches.push([path, key])
        }

        break
      }

      case 'insert_node':
      case 'remove_node':
      case 'merge_node':
      case 'split_node': {
        for (const [node, path] of Editor.levels(e, {
          at: Path.parent(op.path),
        })) {
          const key = ReactEditor.findKey(e, node)
          matches.push([path, key])
        }

        break
      }

      case 'move_node': {
        for (const [node, path] of Editor.levels(e, {
          at: Path.common(Path.parent(op.path), Path.parent(op.newPath)),
        })) {
          const key = ReactEditor.findKey(e, node)
          matches.push([path, key])
        }
        break
      }
    }

    apply(op)

    for (const [path, key] of matches) {
      const [node] = Editor.node(e, path)
      NODE_TO_KEY.set(node, key)
    }
  }

  e.setFragmentData = (data: Pick<DataTransfer, 'getData' | 'setData'>) => {
    const { selection } = e

    if (!selection) {
      return
    }

    const [start, end] = Range.edges(selection)
    const startVoid = Editor.void(e, { at: start.path })
    const endVoid = Editor.void(e, { at: end.path })

    if (Range.isCollapsed(selection) && !startVoid) {
      return
    }

    // Create a fake selection so that we can add a Base64-encoded copy of the
    // fragment to the HTML, to decode on future pastes.
    const domRange = ReactEditor.toDOMRange(e, selection)
    let contents = domRange.cloneContents()
    let attach = contents.childNodes[0] as HTMLElement

    // Make sure attach is non-empty, since empty nodes will not get copied.
    contents.childNodes.forEach(node => {
      if (node.textContent && node.textContent.trim() !== '') {
        attach = node as HTMLElement
      }
    })

    // COMPAT: If the end node is a void node, we need to move the end of the
    // range from the void node's spacer span, to the end of the void node's
    // content, since the spacer is before void's content in the DOM.
    if (endVoid) {
      const [voidNode] = endVoid
      const r = domRange.cloneRange()
      const domNode = ReactEditor.toDOMNode(e, voidNode)
      r.setEndAfter(domNode)
      contents = r.cloneContents()
    }

    // COMPAT: If the start node is a void node, we need to attach the encoded
    // fragment to the void node's content node instead of the spacer, because
    // attaching it to empty `<div>/<span>` nodes will end up having it erased by
    // most browsers. (2018/04/27)
    if (startVoid) {
      attach = contents.querySelector('[data-slate-spacer]')! as HTMLElement
    }

    // Remove any zero-width space spans from the cloned DOM so that they don't
    // show up elsewhere when pasted.
    Array.from(contents.querySelectorAll('[data-slate-zero-width]')).forEach(
      zw => {
        const isNewline = zw.getAttribute('data-slate-zero-width') === 'n'
        zw.textContent = isNewline ? '\n' : ''
      }
    )

    // Set a `data-slate-fragment` attribute on a non-empty node, so it shows up
    // in the HTML, and can be used for intra-Slate pasting. If it's a text
    // node, wrap it in a `<span>` so we have something to set an attribute on.
    if (isDOMText(attach)) {
      const span = document.createElement('span')
      // COMPAT: In Chrome and Safari, if we don't add the `white-space` style
      // then leading and trailing spaces will be ignored. (2017/09/21)
      span.style.whiteSpace = 'pre'
      span.appendChild(attach)
      contents.appendChild(span)
      attach = span
    }

    const fragment = e.getFragment()
    const string = JSON.stringify(fragment)
    const encoded = window.btoa(encodeURIComponent(string))
    attach.setAttribute('data-slate-fragment', encoded)
    data.setData('application/x-slate-fragment', encoded)

    // Add the content to a <div> so that we can get its inner HTML.
    const div = document.createElement('div')
    div.appendChild(contents)
    div.setAttribute('hidden', 'true')
    document.body.appendChild(div)
    data.setData('text/html', div.innerHTML)
    data.setData('text/plain', getPlainText(div))
    document.body.removeChild(div)
    return data
  }

  e.insertData = (data: DataTransfer) => {
    const fragment = data.getData('application/x-slate-fragment')

    if (fragment) {
      const decoded = decodeURIComponent(window.atob(fragment))
      const parsed = JSON.parse(decoded) as Node[]
      e.insertFragment(parsed)
      return
    }

    const text = data.getData('text/plain')

    if (text) {
      const lines = text.split(/\r\n|\r|\n/)
      let split = false

      for (const line of lines) {
        if (split) {
          Transforms.splitNodes(e, { always: true })
        }

        e.insertText(line)
        split = true
      }
    }
  }

  e.onChange = () => {
    // COMPAT: React doesn't batch `setState` hook calls, which means that the
    // children and selection can get out of sync for one render pass. So we
    // have to use this unstable API to ensure it batches them. (2019/12/03)
    // https://github.com/facebook/react/issues/14259#issuecomment-439702367
    ReactDOM.unstable_batchedUpdates(() => {
      const onContextChange = EDITOR_TO_ON_CHANGE.get(e)

      if (onContextChange) {
        onContextChange()
      }

      onChange()
    })
  }

  return e
}
