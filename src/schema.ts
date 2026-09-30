/**
 * The GRHM standard-library schema: every operation, its aliases, keyword
 * properties, and positional shape. The checker validates against this
 * registry and the code generator lowers from it, so the two can never
 * disagree about what the language accepts.
 */

export interface PropType {
  kind: 'number' | 'string' | 'boolean' | 'size' | 'color' | 'enum' | 'expr' | 'ref' | 'route';
  values?: string[];
}

export interface PositionalSpec {
  name: string;
  type: 'ident' | 'string' | 'expr' | 'element' | 'any';
  required: boolean;
  /** Allow any number of trailing occurrences. */
  variadic?: boolean;
}

export type OpCategory =
  | 'layout'
  | 'content'
  | 'interactive'
  | 'composition'
  | 'behavior'
  | 'declaration'
  | 'event'
  | 'action';

export interface OpSchema {
  name: string;
  aliases: string[];
  category: OpCategory;
  /** Extra props beyond shared style props. */
  props: Record<string, PropType>;
  /** Whether shared style props apply. */
  styled: boolean;
  /** What non-positional rest items are allowed to be. */
  children: 'elements' | 'none' | 'actions' | 'special';
  positional: PositionalSpec[];
  doc: string;
}

const num: PropType = { kind: 'number' };
const str: PropType = { kind: 'string' };
const bool: PropType = { kind: 'boolean' };
const size: PropType = { kind: 'size' };
const color: PropType = { kind: 'color' };
const expr: PropType = { kind: 'expr' };
const ref: PropType = { kind: 'ref' };

/** Style props shared by all styled elements. `-sm`/`-md` responsive suffixes allowed. */
export const STYLE_PROPS: Record<string, PropType> = {
  pad: size,
  gap: size,
  margin: size,
  bg: color,
  color: color,
  radius: size,
  size: size,
  weight: { kind: 'enum', values: ['normal', 'medium', 'semibold', 'bold'] },
  align: { kind: 'enum', values: ['start', 'center', 'end', 'stretch', 'baseline'] },
  justify: { kind: 'enum', values: ['start', 'center', 'end', 'between', 'around'] },
  w: size,
  h: size,
  'max-w': size,
  grow: bool,
  wrap: bool,
  border: color,
  shadow: { kind: 'enum', values: ['sm', 'md', 'lg'] },
};

/** Declarative motion, lowered to CSS animations/transitions behind a reduced-motion guard. */
export const MOTION_PROPS: Record<string, PropType> = {
  enter: { kind: 'enum', values: ['fade', 'fade-up', 'fade-down', 'scale-in', 'slide-left', 'slide-right'] },
  dur: num,
  delay: num,
  ease: { kind: 'enum', values: ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'spring'] },
  /** Per-child delay (ms); children inherit this element's :enter animation as a sequence. */
  stagger: num,
  /** Gesture transition on pointer hover/focus. */
  hover: { kind: 'enum', values: ['lift', 'grow', 'dim'] },
};

export const RESPONSIVE_SUFFIXES = ['sm', 'md'] as const;

/** Media query bounds for responsive suffixes. */
export const BREAKPOINTS: Record<(typeof RESPONSIVE_SUFFIXES)[number], string> = {
  sm: '(max-width: 640px)',
  md: '(max-width: 960px)',
};

const OPS: OpSchema[] = [
  // Declarations -----------------------------------------------------------
  {
    name: 'app',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'Application root. Children: theme, data, state, page, component.',
  },
  {
    name: 'theme',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Design token declarations.',
  },
  {
    name: 'token',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [
      { name: 'name', type: 'ident', required: true },
      { name: 'value', type: 'string', required: true },
    ],
    doc: 'A named design token, referenced as $name in color/size positions.',
  },
  {
    name: 'data',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Data declarations. Children: resource.',
  },
  {
    name: 'resource',
    aliases: [],
    category: 'declaration',
    props: { default: expr, poll: num, live: bool },
    styled: false,
    children: 'none',
    positional: [
      { name: 'name', type: 'ident', required: true },
      { name: 'url', type: 'string', required: true },
    ],
    doc: 'Async HTTP resource with data/loading/error states. :poll n re-fetches every n seconds; :live true re-fetches on server db changes (SSE).',
  },
  {
    name: 'state',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [
      { name: 'name', type: 'ident', required: true },
      { name: 'init', type: 'expr', required: true },
    ],
    doc: 'App-level shared state, readable across pages and components.',
  },
  {
    name: 'local',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [
      { name: 'name', type: 'ident', required: true },
      { name: 'init', type: 'expr', required: true },
    ],
    doc: 'Component- or page-local state.',
  },
  {
    name: 'page',
    aliases: [],
    category: 'declaration',
    props: { title: expr },
    styled: false,
    children: 'elements',
    positional: [
      { name: 'route', type: 'string', required: true },
      { name: 'name', type: 'ident', required: true },
    ],
    doc: 'A routed page. Route templates use {param} segments; :title sets document.title.',
  },
  {
    name: 'component',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'elements',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'A reusable component. First child may be a (props ...) form.',
  },
  {
    name: 'props',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Component prop declarations: (props (name string) (on-buy action)).',
  },
  {
    name: 'use',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [{ name: 'module', type: 'string', required: true }],
    doc: 'JavaScript interop: (use "pkg-or-./path" (import name [jsName]) (import-default name)).',
  },
  {
    name: 'db',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Database schema: (db (table name (col type ...)...) (seed table (row ...)...)). Compiles to SQLite behind the generated API server.',
  },
  {
    name: 'table',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'Table declaration inside (db ...): columns are (name auto|string|number|boolean [:default v] [:optional true] [:indexed true] [:references other-table]).',
  },
  {
    name: 'seed',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [{ name: 'table', type: 'ident', required: true }],
    doc: 'Seed rows inside (db ...): (seed table (row :col value ...) ...). Applied when the table is empty (and after each test reset).',
  },
  {
    name: 'row',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [],
    doc: 'One seed row inside (seed ...): (row :col literal ...).',
  },
  {
    name: 'api',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'HTTP API: (api (get "/api/x" handler) (post "/api/x" [:auth true] (input (name string)...) handler) ...). Handlers are expressions over route params, body, user (with :auth), fns, and db ops.',
  },
  {
    name: 'input',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Request-body contract inside an api route: (input (name string|number|boolean [:optional true :min n :max n :integer true :min-len n :max-len n :format email|uuid|url]) ...). Validated at check time against (send ...) and at runtime (400 on mismatch).',
  },
  {
    name: 'auth',
    aliases: [],
    category: 'declaration',
    props: { provider: str },
    styled: false,
    children: 'none',
    positional: [{ name: 'users-table', type: 'ident', required: true }],
    doc: 'Session auth: (auth users [:provider "./identity.ts"]). Provides POST /api/auth/signup|login|logout|logout-all and GET /api/auth/me; routes marked :auth true see a `user` row.',
  },
  {
    name: 'enum',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [
      { name: 'name', type: 'ident', required: true },
      { name: 'member', type: 'ident', required: true, variadic: true },
    ],
    doc: 'Named value set: (enum status open closed). Members read as strings via status.open; (match ...) over an enum-typed state is exhaustiveness-checked.',
  },
  {
    name: 'env',
    aliases: [],
    category: 'declaration',
    props: { default: str },
    styled: false,
    children: 'none',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'Server config from the environment: (env stripe-key [:default ""]). Read in api handlers as env.stripe-key; the server validates presence at startup.',
  },
  {
    name: 'job',
    aliases: [],
    category: 'declaration',
    props: { every: num },
    styled: false,
    children: 'special',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'Recurring server task: (job prune :every 3600 expr). Body is one server expression (db ops, fns, env) run every :every seconds.',
  },
  {
    name: 'uploads',
    aliases: [],
    category: 'declaration',
    props: { 'max-kb': num, public: bool, 'quota-mb': num, 'user-quota-mb': num },
    styled: false,
    children: 'none',
    positional: [],
    doc: 'Uploads: :max-kb (default 5120), :public (default false with auth), :quota-mb (1024), :user-quota-mb (100). Private files require their owner session. Pair with file-input.',
  },
  {
    name: 'i18n',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Message catalogs: (i18n (locale en (msg key "text {param}")...) (locale fr ...)). The first locale is the default; read with (t key :param expr). Declare (state locale "en") to switch at runtime.',
  },
  {
    name: 'locale',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'One locale inside (i18n ...); children are (msg key "text") forms.',
  },
  {
    name: 'msg',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [
      { name: 'key', type: 'ident', required: true },
      { name: 'text', type: 'string', required: true },
    ],
    doc: 'One message inside (locale ...): {param} placeholders fill from (t key :param v).',
  },
  {
    name: 'dark',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Dark-scheme token overrides inside (theme ...): applied under prefers-color-scheme: dark.',
  },
  {
    name: 'fn',
    aliases: ['defn'],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'Pure function: (fn name (param...) body-expr). Recursion allowed; body may use params, other fns, and imports (not state).',
  },
  {
    name: 'import',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [
      { name: 'name', type: 'ident', required: true },
      { name: 'js-name', type: 'ident', required: false },
    ],
    doc: 'Named import inside (use ...). jsName defaults to the camelCased name.',
  },
  {
    name: 'import-default',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [{ name: 'name', type: 'ident', required: true }],
    doc: 'Default import inside (use ...).',
  },
  {
    name: 'include',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'none',
    positional: [{ name: 'path', type: 'string', required: true }],
    doc: 'Splice another .grhm file (app-level forms) into the app.',
  },

  // Layout -----------------------------------------------------------------
  {
    name: 'vstack',
    aliases: ['v'],
    category: 'layout',
    props: {},
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'Vertical stack.',
  },
  {
    name: 'hstack',
    aliases: ['h'],
    category: 'layout',
    props: {},
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'Horizontal stack.',
  },
  {
    name: 'grid',
    aliases: [],
    category: 'layout',
    props: { cols: num },
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'CSS grid with a column count.',
  },
  {
    name: 'section',
    aliases: [],
    category: 'layout',
    props: {},
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'Semantic section landmark.',
  },
  {
    name: 'scroll',
    aliases: [],
    category: 'layout',
    props: { dir: { kind: 'enum', values: ['x', 'y'] } },
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'Scrollable region.',
  },
  {
    name: 'card',
    aliases: [],
    category: 'layout',
    props: { key: expr },
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'Card container with sensible default chrome.',
  },
  {
    name: 'spacer',
    aliases: [],
    category: 'layout',
    props: {},
    styled: true,
    children: 'none',
    positional: [{ name: 'size', type: 'expr', required: false }],
    doc: 'Fixed or flexible space.',
  },

  // Content ----------------------------------------------------------------
  {
    name: 'text',
    aliases: ['txt'],
    category: 'content',
    props: {},
    styled: true,
    children: 'none',
    positional: [{ name: 'content', type: 'expr', required: true, variadic: true }],
    doc: 'Inline text; positional parts are concatenated.',
  },
  {
    name: 'heading',
    aliases: [],
    category: 'content',
    props: { level: num },
    styled: true,
    children: 'none',
    positional: [{ name: 'content', type: 'expr', required: true, variadic: true }],
    doc: 'Heading (level 1-6, default 1).',
  },
  {
    name: 'image',
    aliases: ['img'],
    category: 'content',
    props: { alt: expr, fit: { kind: 'enum', values: ['cover', 'contain', 'fill'] } },
    styled: true,
    children: 'none',
    positional: [{ name: 'src', type: 'expr', required: true }],
    doc: 'Image. Provide :alt for accessibility.',
  },
  {
    name: 'link',
    aliases: [],
    category: 'content',
    props: { to: { kind: 'route' } },
    styled: true,
    children: 'elements',
    positional: [{ name: 'label', type: 'expr', required: false }],
    doc: 'In-app navigation link.',
  },
  {
    name: 'list',
    aliases: [],
    category: 'content',
    props: {},
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'Unordered list; each child renders as a list item.',
  },
  {
    name: 'money',
    aliases: [],
    category: 'content',
    props: { currency: str },
    styled: true,
    children: 'none',
    positional: [{ name: 'amount', type: 'expr', required: true }],
    doc: 'Localized currency amount.',
  },
  {
    name: 'skeleton',
    aliases: [],
    category: 'content',
    props: { lines: num },
    styled: true,
    children: 'none',
    positional: [],
    doc: 'Loading placeholder: shimmering bars (:lines 1–100, default 3). Show while a resource is loading.',
  },

  // Interactive ------------------------------------------------------------
  {
    name: 'form',
    aliases: [],
    category: 'interactive',
    props: {},
    styled: true,
    children: 'special',
    positional: [],
    doc: 'Form; attach a (submit ...) child, which prevents default submission.',
  },
  {
    name: 'dialog',
    aliases: [],
    category: 'interactive',
    props: { open: ref, title: expr },
    styled: true,
    children: 'elements',
    positional: [],
    doc: 'Modal dialog controlled by an :open boolean state reference.',
  },
  {
    name: 'tabs',
    aliases: [],
    category: 'interactive',
    props: { value: ref },
    styled: true,
    children: 'special',
    positional: [],
    doc: 'Tab strip; children are (tab "Label" body...) forms. :value state is optional.',
  },
  {
    name: 'tab',
    aliases: [],
    category: 'interactive',
    props: {},
    styled: false,
    children: 'elements',
    positional: [{ name: 'label', type: 'expr', required: true }],
    doc: 'One tab panel inside (tabs ...).',
  },
  {
    name: 'menu',
    aliases: [],
    category: 'interactive',
    props: {},
    styled: true,
    children: 'special',
    positional: [{ name: 'label', type: 'expr', required: true }],
    doc: 'Dropdown menu; children are (item "Label" action...) forms.',
  },
  {
    name: 'item',
    aliases: [],
    category: 'interactive',
    props: {},
    styled: false,
    children: 'actions',
    positional: [{ name: 'label', type: 'expr', required: true }],
    doc: 'One activatable entry inside (menu ...).',
  },
  {
    name: 'table',
    aliases: [],
    category: 'content',
    props: {},
    styled: true,
    children: 'special',
    positional: [
      { name: 'var', type: 'ident', required: true },
      { name: 'items', type: 'expr', required: true },
    ],
    doc: 'Data table: (table row items (col "Header" cell...) ...).',
  },
  {
    name: 'col',
    aliases: [],
    category: 'content',
    props: {},
    styled: false,
    children: 'elements',
    positional: [{ name: 'header', type: 'expr', required: true }],
    doc: 'One column inside (table ...); children render in each row cell.',
  },
  {
    name: 'button',
    aliases: ['btn'],
    category: 'interactive',
    props: { variant: { kind: 'enum', values: ['primary', 'secondary', 'ghost'] }, disabled: expr },
    styled: true,
    children: 'special',
    positional: [{ name: 'label', type: 'expr', required: false }],
    doc: 'Button; attach behavior with a (click ...) child.',
  },
  {
    name: 'input',
    aliases: [],
    category: 'interactive',
    props: {
      value: ref,
      placeholder: str,
      label: expr,
      required: bool,
      type: { kind: 'enum', values: ['text', 'password', 'email', 'number', 'date', 'time', 'url'] },
      pattern: str,
      min: num,
      max: num,
      'min-len': num,
      'max-len': num,
      error: expr,
    },
    styled: true,
    children: 'special',
    positional: [],
    doc: 'Text input, two-way bound to :value state. Native validation via :required/:pattern/:min/:max/:min-len/:max-len; :error renders an inline message when truthy.',
  },
  {
    name: 'file-input',
    aliases: [],
    category: 'interactive',
    props: { label: expr, to: ref },
    styled: true,
    children: 'none',
    positional: [],
    doc: 'File picker: uploads the chosen file and writes its URL into :to (string state). Requires (uploads ...).',
  },
  {
    name: 'checkbox',
    aliases: [],
    category: 'interactive',
    props: { checked: ref, label: expr },
    styled: true,
    children: 'special',
    positional: [],
    doc: 'Checkbox, two-way bound to :checked state.',
  },
  {
    name: 'select',
    aliases: [],
    category: 'interactive',
    props: { value: ref, options: expr, label: expr },
    styled: true,
    children: 'special',
    positional: [],
    doc: 'Select, two-way bound to :value; :options is a list expression.',
  },

  // Composition ------------------------------------------------------------
  {
    name: 'each',
    aliases: [],
    category: 'composition',
    props: { key: expr },
    styled: false,
    children: 'elements',
    positional: [
      { name: 'var', type: 'ident', required: true },
      { name: 'items', type: 'expr', required: true },
    ],
    doc: 'Repeat children for every item of a list expression.',
  },
  {
    name: 'if',
    aliases: [],
    category: 'composition',
    props: {},
    styled: false,
    children: 'elements',
    positional: [{ name: 'cond', type: 'expr', required: true }],
    doc: 'Conditional: (if cond then-element else-element?).',
  },
  {
    name: 'when',
    aliases: [],
    category: 'composition',
    props: {},
    styled: false,
    children: 'elements',
    positional: [{ name: 'cond', type: 'expr', required: true }],
    doc: 'Render children only when the condition holds.',
  },
  {
    name: 'slot',
    aliases: [],
    category: 'composition',
    props: {},
    styled: false,
    children: 'none',
    positional: [],
    doc: 'Renders the children passed to a component instance.',
  },

  // Events and actions -----------------------------------------------------
  {
    name: 'click',
    aliases: [],
    category: 'event',
    props: {},
    styled: false,
    children: 'actions',
    positional: [],
    doc: 'Click handler; children are actions run in order.',
  },
  {
    name: 'change',
    aliases: [],
    category: 'event',
    props: {},
    styled: false,
    children: 'actions',
    positional: [],
    doc: 'Change handler for inputs.',
  },
  {
    name: 'submit',
    aliases: [],
    category: 'event',
    props: {},
    styled: false,
    children: 'actions',
    positional: [],
    doc: 'Submit handler.',
  },
  {
    name: 'set',
    aliases: [],
    category: 'action',
    props: {},
    styled: false,
    children: 'none',
    positional: [
      { name: 'target', type: 'ident', required: true },
      { name: 'value', type: 'expr', required: true },
    ],
    doc: 'Assign a new value to writable state.',
  },
  {
    name: 'nav',
    aliases: [],
    category: 'action',
    props: {},
    styled: false,
    children: 'none',
    positional: [{ name: 'to', type: 'any', required: true }],
    doc: 'Navigate to a route: a string or a (path ...) form.',
  },
  {
    name: 'path',
    aliases: [],
    category: 'behavior',
    props: {},
    styled: false,
    children: 'none',
    positional: [{ name: 'template', type: 'string', required: true }],
    doc: 'Route template with named params: (path "/products/{id}" :id p.id).',
  },
  {
    name: 'toast',
    aliases: [],
    category: 'action',
    props: { tone: { kind: 'enum', values: ['info', 'success', 'error'] } },
    styled: false,
    children: 'none',
    positional: [{ name: 'message', type: 'expr', required: true }],
    doc: 'Show a transient notification: (toast "Saved" :tone success). Announced via a polite live region.',
  },
  {
    name: 'try',
    aliases: [],
    category: 'action',
    props: {},
    styled: false,
    children: 'actions',
    positional: [],
    doc: 'Run actions, jumping to the trailing (catch actions...) child on failure: (try (send ...) (refresh r) (catch (toast "Failed" :tone error))).',
  },
  {
    name: 'catch',
    aliases: [],
    category: 'action',
    props: {},
    styled: false,
    children: 'actions',
    positional: [],
    doc: 'Failure branch inside (try ...).',
  },

  // Tests (lowered to Playwright by `grhm test`) -----------------------------
  {
    name: 'tests',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [],
    doc: 'Top-level browser test suite; children are (test "name" step...) forms.',
  },
  {
    name: 'test',
    aliases: [],
    category: 'declaration',
    props: {},
    styled: false,
    children: 'special',
    positional: [{ name: 'name', type: 'string', required: true }],
    doc: 'One browser test; steps: visit, click, fill, expect-text, expect-node, expect-url.',
  },
];

/** Test step operations and their argument shapes. */
export const TEST_STEPS: Record<string, { args: ('route' | 'string' | 'node-or-string' | 'number' | 'expr')[] }> = {
  visit: { args: ['route'] },
  click: { args: ['node-or-string'] },
  fill: { args: ['node-or-string', 'string'] },
  press: { args: ['string'] },
  'expect-text': { args: ['string'] },
  'expect-node': { args: ['node-or-string'] },
  'expect-gone': { args: ['string'] },
  'expect-count': { args: ['node-or-string', 'number'] },
  'expect-value': { args: ['node-or-string', 'string'] },
  'expect-url': { args: ['route'] },
  'expect-eq': { args: ['expr', 'expr'] },
  screenshot: { args: ['string'] },
};

/** Browser globals available to interop calls without declaration. */
export const BROWSER_GLOBALS = new Set([
  'window',
  'document',
  'console',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'history',
  'fetch',
  'alert',
  'confirm',
  'prompt',
]);

export interface ExprOpSpec {
  minArity: number;
  maxArity: number | undefined;
  /** Binary JS operator, when the op lowers to one. */
  js: string | undefined;
  /** Number of parameters the function-valued first argument must take. */
  fnArity?: number;
  /** Simple operand contracts; nullable lists retain the null-as-empty convention. */
  inputs?: readonly ('number' | 'string' | 'record' | 'list' | 'any')[];
  /** Apply the last input contract to additional variadic operands. */
  variadicInput?: boolean;
  /** Scalar results shared by inference and schema consumers. */
  result?: 'number' | 'string' | 'boolean';
  doc?: string;
}

/** Pure expression operations usable inside expr positions. */
export const EXPR_OPS: Record<string, ExprOpSpec> = {
  // Arithmetic, comparison, logic ------------------------------------------
  '+': { minArity: 2, maxArity: undefined, js: '+' },
  '-': { minArity: 1, maxArity: undefined, js: '-' },
  '*': { minArity: 2, maxArity: undefined, js: '*' },
  '/': { minArity: 2, maxArity: undefined, js: '/' },
  mod: { minArity: 2, maxArity: 2, js: undefined, doc: 'remainder' },
  '=': { minArity: 2, maxArity: 2, js: '===' },
  '!=': { minArity: 2, maxArity: 2, js: '!==' },
  '<': { minArity: 2, maxArity: 2, js: '<' },
  '>': { minArity: 2, maxArity: 2, js: '>' },
  '<=': { minArity: 2, maxArity: 2, js: '<=' },
  '>=': { minArity: 2, maxArity: 2, js: '>=' },
  and: { minArity: 2, maxArity: undefined, js: '&&' },
  or: { minArity: 2, maxArity: undefined, js: '||' },
  not: { minArity: 1, maxArity: 1, js: undefined },
  // Math --------------------------------------------------------------------
  abs: { minArity: 1, maxArity: 1, js: undefined },
  round: { minArity: 1, maxArity: 1, js: undefined },
  floor: { minArity: 1, maxArity: 1, js: undefined },
  ceil: { minArity: 1, maxArity: 1, js: undefined },
  sqrt: { minArity: 1, maxArity: 1, js: undefined },
  pow: { minArity: 2, maxArity: 2, js: undefined, doc: '(pow base exp)' },
  min: { minArity: 1, maxArity: undefined, js: undefined },
  max: { minArity: 1, maxArity: undefined, js: undefined },
  random: { minArity: 0, maxArity: 0, js: undefined, doc: '0..1' },
  'to-fixed': { minArity: 2, maxArity: 2, js: undefined, doc: '(to-fixed digits x) -> string' },
  'to-num': { minArity: 1, maxArity: 1, js: undefined },
  // Strings -----------------------------------------------------------------
  concat: { minArity: 1, maxArity: undefined, js: undefined, doc: 'string interpolation' },
  'to-str': { minArity: 1, maxArity: 1, js: undefined },
  upper: { minArity: 1, maxArity: 1, js: undefined },
  lower: { minArity: 1, maxArity: 1, js: undefined },
  trim: { minArity: 1, maxArity: 1, js: undefined },
  split: { minArity: 2, maxArity: 2, js: undefined, doc: '(split sep s) -> list' },
  join: { minArity: 2, maxArity: 2, js: undefined, doc: '(join sep xs) -> string' },
  replace: { minArity: 3, maxArity: 3, js: undefined, doc: '(replace from to s), all occurrences' },
  'starts-with': { minArity: 2, maxArity: 2, js: undefined, doc: '(starts-with prefix s)' },
  'ends-with': { minArity: 2, maxArity: 2, js: undefined, doc: '(ends-with suffix s)' },
  slice: { minArity: 3, maxArity: 3, js: undefined, doc: '(slice start end x), strings and lists' },
  // Lists (function-first, like Lisp) ----------------------------------------
  arr: { minArity: 0, maxArity: undefined, js: undefined, doc: 'list literal' },
  count: { minArity: 1, maxArity: 1, js: undefined, doc: 'length of list or string' },
  map: { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(map f xs)' },
  filter: { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(filter pred xs)' },
  find: { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(find pred xs)' },
  some: { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(some pred xs)' },
  every: { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(every pred xs)' },
  reduce: { minArity: 3, maxArity: 3, js: undefined, fnArity: 2, doc: '(reduce f init xs), f takes (acc x)' },
  'sort-by': { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(sort-by key-fn xs), ascending' },
  reverse: { minArity: 1, maxArity: 1, js: undefined },
  take: { minArity: 2, maxArity: 2, js: undefined, doc: '(take n xs)' },
  drop: { minArity: 2, maxArity: 2, js: undefined, doc: '(drop n xs)' },
  nth: { minArity: 2, maxArity: 2, js: undefined, doc: '(nth i xs)' },
  first: { minArity: 1, maxArity: 1, js: undefined },
  last: { minArity: 1, maxArity: 1, js: undefined },
  append: { minArity: 2, maxArity: 2, js: undefined, doc: '(append xs x) -> new list' },
  contains: { minArity: 2, maxArity: 2, js: undefined, doc: '(contains x needle), strings and lists' },
  range: { minArity: 2, maxArity: 2, js: undefined, doc: '(range from to), to exclusive' },
  sum: { minArity: 1, maxArity: 1, js: undefined },
  // Records -------------------------------------------------------------------
  obj: { minArity: 0, maxArity: 0, js: undefined, doc: '(obj :key value ...) record literal' },
  get: { minArity: 2, maxArity: 2, js: undefined, doc: '(get record key) dynamic field access' },
  keys: { inputs: ['record'], minArity: 1, maxArity: 1, js: undefined, doc: '(keys record) -> own enumerable string keys' },
  values: { inputs: ['record'], minArity: 1, maxArity: 1, js: undefined, doc: '(values record) -> own enumerable values' },
  entries: { inputs: ['record'], minArity: 1, maxArity: 1, js: undefined, doc: '(entries record) -> list of [key, value] pairs' },
  'from-entries': { inputs: ['list'], minArity: 1, maxArity: 1, js: undefined, doc: '(from-entries pairs) -> record; later duplicate keys win' },
  assoc: { inputs: ['record', 'any', 'any'], minArity: 3, maxArity: 3, js: undefined, doc: '(assoc record key value) -> new record with an own field; original unchanged' },
  dissoc: { inputs: ['record', 'any'], minArity: 2, maxArity: 2, js: undefined, doc: '(dissoc record key) -> new record without the own field' },
  merge: { inputs: ['record'], variadicInput: true, minArity: 1, maxArity: undefined, js: undefined, doc: '(merge record ...) -> new record; later own fields win' },
  'has-key': { inputs: ['record', 'any'], result: 'boolean', minArity: 2, maxArity: 2, js: undefined, doc: '(has-key record key) -> boolean; ignores inherited properties' },
  // Data interchange and general collection processing -----------------------
  'json-parse': { inputs: ['string'], minArity: 1, maxArity: 1, js: undefined, doc: '(json-parse text) -> unknown JSON value; invalid JSON throws, catch with attempt' },
  'json-stringify': { inputs: ['any'], result: 'string', minArity: 1, maxArity: 1, js: undefined, doc: '(json-stringify value) -> compact JSON string; an undefined top-level value becomes "null"' },
  'flat-map': { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(flat-map f xs) -> concatenated callback results, flattened one level' },
  flatten: { inputs: ['list'], minArity: 1, maxArity: 1, js: undefined, doc: '(flatten xs) -> new list flattened one level' },
  unique: { inputs: ['list'], minArity: 1, maxArity: 1, js: undefined, doc: '(unique xs) -> first occurrences; SameValueZero comparison, records compare by identity' },
  zip: { inputs: ['list', 'list'], minArity: 2, maxArity: 2, js: undefined, doc: '(zip xs ys) -> pairs, stopping at the shorter list' },
  chunk: { inputs: ['number', 'list'], minArity: 2, maxArity: 2, js: undefined, doc: '(chunk positive-integer xs) -> consecutive lists, final chunk may be shorter; invalid size throws' },
  'group-by': { minArity: 2, maxArity: 2, js: undefined, fnArity: 1, doc: '(group-by key-fn xs) -> record of lists keyed by String(key-fn item)' },
  // Text processing, URLs, UTC dates, and math --------------------------------
  'regex-test': { inputs: ['string', 'string', 'string'], result: 'boolean', minArity: 2, maxArity: 3, js: undefined, doc: '(regex-test pattern text [flags]) -> boolean; invalid patterns/flags throw' },
  'regex-find': { inputs: ['string', 'string', 'string'], minArity: 2, maxArity: 3, js: undefined, doc: '(regex-find pattern text [flags]) -> full match and capture strings, or null; unmatched captures are undefined' },
  'regex-replace': { inputs: ['string', 'string', 'string', 'string'], result: 'string', minArity: 3, maxArity: 4, js: undefined, doc: '(regex-replace pattern replacement text [flags]) -> string; flags default to g' },
  'url-encode': { inputs: ['string'], result: 'string', minArity: 1, maxArity: 1, js: undefined, doc: '(url-encode text) -> percent-encoded URL component' },
  'url-decode': { inputs: ['string'], result: 'string', minArity: 1, maxArity: 1, js: undefined, doc: '(url-decode text) -> decoded URL component; malformed escapes throw' },
  'date-iso': { inputs: ['number'], result: 'string', minArity: 1, maxArity: 1, js: undefined, doc: '(date-iso epoch-ms) -> UTC ISO 8601 string; invalid date throws' },
  'date-parse': { inputs: ['string'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: '(date-parse text) -> epoch milliseconds or NaN; prefer ISO 8601 input' },
  clamp: { inputs: ['number', 'number', 'number'], result: 'number', minArity: 3, maxArity: 3, js: undefined, doc: '(clamp minimum maximum value) -> bounded number' },
  trunc: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'truncate toward zero' },
  sign: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'numeric sign, preserving zero and NaN' },
  sin: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'sine, input in radians' },
  cos: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'cosine, input in radians' },
  tan: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'tangent, input in radians' },
  asin: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'inverse sine, result in radians' },
  acos: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'inverse cosine, result in radians' },
  atan: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'inverse tangent, result in radians' },
  atan2: { inputs: ['number', 'number'], result: 'number', minArity: 2, maxArity: 2, js: undefined, doc: '(atan2 y x) -> angle in radians' },
  exp: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'e raised to a power' },
  log: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'natural logarithm' },
  log10: { inputs: ['number'], result: 'number', minArity: 1, maxArity: 1, js: undefined, doc: 'base-10 logarithm' },
  // Null handling ---------------------------------------------------------------
  'or-else': { minArity: 2, maxArity: 2, js: undefined, doc: '(or-else x fallback), fallback when x is null/undefined' },
  'is-null': { minArity: 1, maxArity: 1, js: undefined },
  'not-null': { minArity: 1, maxArity: 1, js: undefined },
  // Errors ----------------------------------------------------------------------
  attempt: { minArity: 2, maxArity: 2, js: undefined, doc: '(attempt expr fallback), fallback if expr throws' },
  // Dates -----------------------------------------------------------------------
  now: { minArity: 0, maxArity: 0, js: undefined, doc: 'current time, ms since epoch' },
  'date-str': { minArity: 1, maxArity: 1, js: undefined, doc: '(date-str ms) -> localized date string' },
  // Special forms (validated structurally) -----------------------------------
  path: { minArity: 1, maxArity: undefined, js: undefined, doc: 'route template' },
  fmt: { minArity: 1, maxArity: undefined, js: undefined, doc: '(fmt "Hi {name}" :name x) string template' },
  t: { minArity: 1, maxArity: undefined, js: undefined, doc: '(t msg-key :param expr ...) localized message (see i18n)' },
  cond: { minArity: 1, maxArity: undefined, js: undefined, doc: '(cond (test value)... (else value))' },
  match: { minArity: 2, maxArity: undefined, js: undefined, doc: '(match x (literal value)... (else value)); exhaustive over enums' },
};

/** Column types accepted in (table ...) declarations. */
export const COLUMN_TYPES = new Set(['auto', 'string', 'number', 'boolean']);

/** HTTP methods accepted in (api ...) route declarations. */
export const API_METHODS = new Set(['get', 'post', 'put', 'delete']);

/** Methods usable in the client-side (send method route ...) action. */
export const SEND_METHODS = new Set(['post', 'put', 'delete']);

/**
 * Server-only expression ops, usable inside (api ...) handlers. All take a
 * table name in the first position; insert/update take :column props.
 */
export const SERVER_OPS: Record<string, { doc: string }> = {
  select: { doc: '(select table [:where cond] [:order col] [:desc true] [:limit n] [:offset n]) -> rows; :where compiles to SQL over column refs' },
  insert: { doc: '(insert table :col expr ...) -> created row' },
  update: { doc: '(update table :id expr :col expr ...) -> updated row' },
  'delete-row': { doc: '(delete-row table :id expr) -> {ok}' },
  fail: { doc: '(fail status "message") -> abort the handler with an HTTP error' },
  tx: { doc: '(tx expr) -> run expr inside a transaction, rolling back on failure' },
};

/** Props allowed on (select ...); :where lowers to a SQL WHERE clause. */
export const SELECT_PROPS = new Set(['where', 'order', 'desc', 'limit', 'offset']);

/** Comparison/logic ops supported inside a (select :where ...) expression. */
export const WHERE_OPS = new Set(['=', '!=', '<', '>', '<=', '>=', 'and', 'or', 'not', 'contains']);

const byName = new Map<string, OpSchema>();
for (const op of OPS) {
  byName.set(op.name, op);
  for (const alias of op.aliases) byName.set(alias, op);
}

export function lookupOp(name: string): OpSchema | undefined {
  return byName.get(name);
}

/** Every operation schema, in registry order. */
export function allOps(): OpSchema[] {
  return OPS;
}

export function allOpNames(): string[] {
  return [...byName.keys()];
}

export function allowedProps(op: OpSchema): Set<string> {
  const names = new Set<string>();
  names.add('id');
  for (const key of Object.keys(op.props)) {
    names.add(key);
    if (op.styled) {
      for (const suffix of RESPONSIVE_SUFFIXES) names.add(`${key}-${suffix}`);
    }
  }
  if (op.styled) {
    for (const key of Object.keys(STYLE_PROPS)) {
      names.add(key);
      for (const suffix of RESPONSIVE_SUFFIXES) names.add(`${key}-${suffix}`);
    }
    for (const key of Object.keys(MOTION_PROPS)) names.add(key);
  }
  return names;
}

/** Resolve a (possibly responsive-suffixed) prop name to its type. */
export function propType(op: OpSchema, name: string): { type: PropType; base: string; media: string | undefined } | undefined {
  if (name === 'id') return { type: { kind: 'string' }, base: 'id', media: undefined };
  const direct = op.props[name];
  if (direct !== undefined) return { type: direct, base: name, media: undefined };
  if (!op.styled) return undefined;
  const style = STYLE_PROPS[name];
  if (style !== undefined) return { type: style, base: name, media: undefined };
  const motion = MOTION_PROPS[name];
  if (motion !== undefined) return { type: motion, base: name, media: undefined };
  for (const suffix of RESPONSIVE_SUFFIXES) {
    if (name.endsWith(`-${suffix}`)) {
      const base = name.slice(0, -(suffix.length + 1));
      const baseType = op.props[base] ?? STYLE_PROPS[base];
      if (baseType !== undefined) return { type: baseType, base, media: BREAKPOINTS[suffix] };
    }
  }
  return undefined;
}
