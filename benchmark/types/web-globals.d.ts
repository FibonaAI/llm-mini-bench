/** Browser globals shared by the plain-JavaScript frontend; type checking only, never served. */
interface Window {
    /** Compatibility bridge populated by web/api.js and web/app-context.js. */
    MiniBench: any;
    /** Magpie host bridge injected by _magpie/bridge.js on the plugin boot page. */
    magpie: any;
}
