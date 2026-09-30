/** Native markup and event metadata shared by validation and React lowering. */
export const VOID_ELEMENTS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

export function validElementTag(tag: string): boolean {
  return /^[a-z][A-Za-z0-9]*(?:-[a-z0-9]+)*$/.test(tag);
}

export function validEventName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name);
}

/** React spellings differ from native HTML attribute spellings. */
export const ATTRIBUTE_NAMES: Record<string, string> = {
  class: 'className', for: 'htmlFor', 'http-equiv': 'httpEquiv', 'accept-charset': 'acceptCharset',
  tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength',
  colspan: 'colSpan', rowspan: 'rowSpan', contenteditable: 'contentEditable', spellcheck: 'spellCheck',
  autofocus: 'autoFocus', autocomplete: 'autoComplete', crossorigin: 'crossOrigin',
  srcset: 'srcSet', usemap: 'useMap', frameborder: 'frameBorder', allowfullscreen: 'allowFullScreen',
  formnovalidate: 'formNoValidate', formaction: 'formAction', formenctype: 'formEncType',
  formmethod: 'formMethod', formtarget: 'formTarget', novalidate: 'noValidate',
  datetime: 'dateTime', charset: 'charSet', hreflang: 'hrefLang', referrerpolicy: 'referrerPolicy',
  playsinline: 'playsInline', autoplay: 'autoPlay', srcdoc: 'srcDoc',
  itemprop: 'itemProp', itemscope: 'itemScope', itemtype: 'itemType', itemid: 'itemID', itemref: 'itemRef',
  'xlink:href': 'xlinkHref', 'xml:lang': 'xmlLang', 'xml:space': 'xmlSpace', 'xmlns:xlink': 'xmlnsXlink',
};

export function attributeName(name: string): string {
  if (name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('--')) return name;
  return ATTRIBUTE_NAMES[name] ?? name.replace(/[-:]([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function safeAttributeName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)
    && !/^on/i.test(name)
    && !['children', 'dangerouslySetInnerHTML', 'ref', 'key', '__proto__', 'prototype', 'constructor', 'data-g'].includes(name);
}

const REACT_EVENTS = 'Copy Cut Paste CompositionEnd CompositionStart CompositionUpdate Focus Blur Change BeforeInput Input Reset Submit Invalid Load Error KeyDown KeyPress KeyUp Abort CanPlay CanPlayThrough DurationChange Emptied Encrypted Ended LoadedData LoadedMetadata LoadStart Pause Play Playing Progress RateChange Seeked Seeking Stalled Suspend TimeUpdate VolumeChange Waiting AuxClick Click ContextMenu DoubleClick Drag DragEnd DragEnter DragExit DragLeave DragOver DragStart Drop MouseDown MouseEnter MouseLeave MouseMove MouseOut MouseOver MouseUp Select TouchCancel TouchEnd TouchMove TouchStart PointerDown PointerMove PointerUp PointerCancel PointerEnter PointerLeave PointerOver PointerOut GotPointerCapture LostPointerCapture Scroll ScrollEnd Wheel AnimationStart AnimationEnd AnimationIteration TransitionCancel TransitionEnd TransitionRun TransitionStart Toggle BeforeToggle'.split(' ');

export const REACT_EVENT_NAMES: Record<string, string> = Object.fromEntries(REACT_EVENTS.flatMap((name) => [
  [name.toLowerCase(), 'on' + name],
  [name.replace(/[A-Z]/g, (letter, index: number) => (index === 0 ? '' : '-') + letter.toLowerCase()), 'on' + name],
]));
REACT_EVENT_NAMES.dblclick = 'onDoubleClick';

export const WEB_EVENT_FIELDS: Record<string, 'string' | 'number' | 'boolean' | 'unknown' | 'list' | 'record'> = {
  type: 'string', targetId: 'string', value: 'string', checked: 'boolean', valueAsNumber: 'number',
  key: 'string', code: 'string', repeat: 'boolean', altKey: 'boolean', ctrlKey: 'boolean',
  metaKey: 'boolean', shiftKey: 'boolean', button: 'number', buttons: 'number',
  clientX: 'number', clientY: 'number', pageX: 'number', pageY: 'number',
  pointerId: 'number', pointerType: 'string', pressure: 'number',
  deltaX: 'number', deltaY: 'number', deltaZ: 'number', deltaMode: 'number',
  inputType: 'string', data: 'string', detail: 'unknown', timeStamp: 'number', files: 'list', form: 'record',
};

/** This is emitted only for programs that use native elements or general events. */
export const WEB_RUNTIME_SOURCE = String.raw`import { createElement, useEffect, useRef } from 'react';
import type { CSSProperties, ReactElement, ReactNode, SyntheticEvent } from 'react';

const ATTRIBUTE_NAMES: Record<string, string> = ${JSON.stringify(ATTRIBUTE_NAMES)};
const REACT_EVENT_NAMES: Record<string, string> = ${JSON.stringify(REACT_EVENT_NAMES)};
const VOID_ELEMENTS = new Set(${JSON.stringify([...VOID_ELEMENTS])});

function attributeName(name: string): string {
  if (name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('--')) return name;
  return ATTRIBUTE_NAMES[name] ?? name.replace(/[-:]([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function safeAttributeName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) && !/^on/i.test(name)
    && !['children', 'dangerouslySetInnerHTML', 'ref', 'key', '__proto__', 'prototype', 'constructor', 'data-g'].includes(name);
}

export interface GrhmEvent {
  type: string; targetId: string; value: string; checked: boolean; valueAsNumber: number;
  key: string; code: string; repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
  button: number; buttons: number; clientX: number; clientY: number; pageX: number; pageY: number;
  pointerId: number; pointerType: string; pressure: number;
  deltaX: number; deltaY: number; deltaZ: number; deltaMode: number;
  inputType: string; data: string; detail: unknown; timeStamp: number;
  files: File[]; form: Record<string, FormDataEntryValue | FormDataEntryValue[]>;
}

export interface GrhmEventOptions { prevent?: boolean; stop?: boolean; }
export interface GrhmEventBinding extends GrhmEventOptions {
  name: string; capture?: boolean; handler: (event: GrhmEvent) => void;
}

/** Snapshot event values synchronously so an async action can use them after awaiting. */
export function webEventHandler(handler: (event: GrhmEvent) => void, options: GrhmEventOptions = {}) {
  return (raw: Event | SyntheticEvent): void => {
    if (options.prevent) raw.preventDefault();
    if (options.stop) raw.stopPropagation();
    const native = 'nativeEvent' in raw ? raw.nativeEvent : raw;
    const fields = native as unknown as Record<string, unknown>;
    const target = raw.target as (HTMLInputElement & HTMLFormElement) | null;
    const text = (name: string): string => typeof fields[name] === 'string' ? fields[name] as string : '';
    const number = (name: string): number => typeof fields[name] === 'number' ? fields[name] as number : 0;
    const form: GrhmEvent['form'] = Object.create(null) as GrhmEvent['form'];
    const formElement = target?.tagName === 'FORM' ? target : target?.form;
    if (formElement != null) {
      for (const [name, value] of new FormData(formElement)) {
        const previous = form[name];
        form[name] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
      }
    }
    handler({
      type: raw.type, targetId: target?.id ?? '', value: typeof target?.value === 'string' ? target.value : '',
      checked: target?.checked === true, valueAsNumber: typeof target?.valueAsNumber === 'number' ? target.valueAsNumber : NaN,
      key: text('key'), code: text('code'), repeat: fields.repeat === true,
      altKey: fields.altKey === true, ctrlKey: fields.ctrlKey === true, metaKey: fields.metaKey === true, shiftKey: fields.shiftKey === true,
      button: number('button'), buttons: number('buttons'), clientX: number('clientX'), clientY: number('clientY'),
      pageX: number('pageX'), pageY: number('pageY'), pointerId: number('pointerId'), pointerType: text('pointerType'), pressure: number('pressure'),
      deltaX: number('deltaX'), deltaY: number('deltaY'), deltaZ: number('deltaZ'), deltaMode: number('deltaMode'),
      inputType: text('inputType'), data: text('data'), detail: fields.detail, timeStamp: raw.timeStamp,
      files: Array.from(target?.files ?? []), form,
    });
  };
}

export interface GrhmElementProps {
  tag: string; nodeId: string; attrs?: Record<string, unknown>; className?: string; style?: CSSProperties;
  events?: GrhmEventBinding[]; children?: ReactNode;
}

export function GrhmElement({ tag, nodeId, attrs = {}, className, style, events = [], children }: GrhmElementProps): ReactElement {
  const element = useRef<Element | null>(null);
  // Custom browser events use addEventListener; known events retain React's normal semantics.
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const listeners = events.filter((event) => REACT_EVENT_NAMES[event.name] === undefined).map((event) => {
      const handler = webEventHandler(event.handler, event);
      target.addEventListener(event.name, handler, event.capture);
      return () => target.removeEventListener(event.name, handler, event.capture);
    });
    return () => { for (const remove of listeners) remove(); };
  }, [events, tag]);
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (safeAttributeName(name)) props[attributeName(name)] = value;
  }
  const classes = [props.className, className].filter((value) => typeof value === 'string' && value !== '');
  if (classes.length > 0) props.className = classes.join(' ');
  const nativeStyle = props.style;
  const mergedStyle: Record<string, unknown> = {};
  if (nativeStyle != null && typeof nativeStyle === 'object' && !Array.isArray(nativeStyle)) {
    for (const [name, value] of Object.entries(nativeStyle)) {
      if (name !== '__proto__' && name !== 'constructor' && name !== 'prototype') mergedStyle[attributeName(name)] = value;
    }
  }
  if (style !== undefined || Object.keys(mergedStyle).length > 0) props.style = { ...mergedStyle, ...style };
  else delete props.style;
  for (const event of events) {
    const name = REACT_EVENT_NAMES[event.name];
    if (name !== undefined) props[name + (event.capture ? 'Capture' : '')] = webEventHandler(event.handler, event);
  }
  props['data-g'] = nodeId;
  props.ref = (node: Element | null): void => { element.current = node; };
  return VOID_ELEMENTS.has(tag) ? createElement(tag, props) : createElement(tag, props, children);
}
`;
