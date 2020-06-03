/**
 * @fileoverview Handle backward compatibility when a user opens a site for edition
 *
 */

import * as fs from 'fs'
import * as Path from 'path'
import { writeDataToDom } from '../../client/store/dom'
import { Constants } from '../../constants'
import { getElementsFromDomBC, getPagesFromDom, getSiteFromDom, writeSiteStyles, writeStyles } from './BackwardCompatV2.5.60'
import { PersistantData } from '../../client/store/types'
import { ElementType } from '../../client/element-store/types'

/**
 * class name for containers which are created with sections
 */
const SECTION_CONTAINER: string = 'silex-container-content'

export default class BackwardCompat {
  private data: PersistantData = null
  private frontEndVersion: string[]
  private silexVersion: string[]

  constructor(private rootUrl: string, rootPath = __dirname + '/../../../..') {
    // FIXME: path in constants
    /**
     * the version of the website is stored in the generator tag as "Silex v-X-Y-Z"
     * we get it from package.json
     * used for backward compat and for the static files URLs taken from //{{host}}/static/{{Y-Z}}
     */
    const packageJson = JSON.parse(fs.readFileSync(Path.resolve(rootPath, 'package.json')).toString())
    this.frontEndVersion = packageJson['version:frontend'].split('.').map((s) => parseInt(s))
    this.silexVersion = packageJson['version:backwardcompat'].split('.').map((s) => parseInt(s))

    // const components = require('../../../dist/client/libs/prodotype/components/components.json')
    console.log(`\nSilex starts with backward compat version ${this.silexVersion} and front end version ${this.frontEndVersion}\n`)

  }

  // remove all tags
  // export for tests
  removeIfExist(doc: HTMLDocument, selector: string) {
    Array.from(doc.querySelectorAll(selector))
    .forEach((tag) => tag.remove())
  }

  // remove all useless css class
  // export for tests
  removeUselessCSSClass(doc: HTMLDocument, className: string) {
    Array.from(doc.querySelectorAll('.' + className))
    .forEach((el) => el.classList.remove(className))
  }

  /**
   * handle backward compatibility issues
   * Backwardcompatibility process takes place after opening a file
   * @param {Document} doc
   * @return {Promise} a Promise, resolve can be called with a warning message
   */
  async update(doc: HTMLDocument, data: PersistantData): Promise<[string, PersistantData]> {
    // // fix an issue when the style tag has no type, then json is "broken"
    // const styleTag = doc.querySelector('.' + Constants.JSON_STYLE_TAG_CLASS_NAME);
    // if (styleTag) { styleTag.type = 'text/json'; } // old versions of silex have no json at all so do nothing in that case
    // TODO: move this to the data model (e.g. data.site.silexVersion)

    // we need this.data as to2_2_11 will extract it and set it from the dom
    this.data = data

    // if no generator tag, create one
    let metaNode = doc.querySelector('meta[name="generator"]')
    if (!metaNode) {
      metaNode = doc.createElement('meta')
      metaNode.setAttribute('name', 'generator')
      doc.head.appendChild(metaNode)
    }
    // retrieve the website version from generator tag
    const version = (metaNode.getAttribute('content') || '')
      .replace('Silex v', '')
      .split('.')
      .map((str) => parseInt(str, 10) || 0)

    const hasToUpdate = this.hasToUpdate(version, this.silexVersion)

    // warn the user
    if (this.amIObsolete(version, this.silexVersion)) {
      return ['This website has been saved with a newer version of Silex. Continue at your own risks.', this.data]
    } else if (this.hasToUpdate(version, [2, 2, 7])) {
      return Promise.reject({
        message: 'This website has been saved with an older version of Silex, which is not supported anymore as of March 2018. In order to convert it to a newer version, please go to <a href="https://old.silex.me">old.silex.me</a> to open and then save your website. <a href="https://github.com/silexlabs/Silex/wiki/Website-saved-with-older-version-of-Silex">More about this here</a>',
      })
    } else if (hasToUpdate) {
      // convert to the latest version
      const allActions = {
        '2.2.8': await this.to2_2_8(version, doc),
        '2.2.9': await this.to2_2_9(version, doc),
        '2.2.10': await this.to2_2_10(version, doc),
        '2.2.11': await this.to2_2_11(version, doc), // this will set this.data
      }
      // update the static scripts to match the current server and latest version
      this.updateStatic(doc)
      // store the latest version
      metaNode.setAttribute('content', 'Silex v' + this.silexVersion.join('.'))
      // apply all-time fixes
      this.fixes(doc)
      // build the report for the user
      const report = Object.keys(allActions)
      .filter((_version) => allActions[_version].length > 0)
      .map((_version) => {
        return `<p>Update to version ${ _version }:
            <ul>${ allActions[_version].map((_action) => `<li class="no-list">${ _action }</li>`).join('') }</ul>
        </p>`
      }).join('')
      // save data to dom for front-end.js and other scripts
      // in case data has been changed
      // FIXME: should not have this.data mutated but returned by update scripts
      writeDataToDom(doc, this.data)
      // needs to reload if silex scripts and stylesheets have been updated
      return [`
        <p>This website has been updated to Silex latest version.</p>
        <p>Before you save it, please check that everything is fine. Saving it with another name could be a good idea too (menu file > save as).</p>
        <details>
          <summary>Details</summary>
          <small>
            ${ report }
          </small>
        </details>
      `,
        this.data,
      ]
    } else {
      // update the static scripts to match the current server URL
      this.updateStatic(doc)
      // apply all-time fixes
      this.fixes(doc)
      // resolve immediately
      return ['', this.data]
    }
  }

  /**
   * Check for common errors in editable html files
   */
  fixes(doc) {
    // const pages: HTMLElement[] = Array.from(doc.querySelectorAll(`.${Constants.PAGES_CONTAINER_CLASS_NAME} a[${Constants.TYPE_ATTR}="page"]`));
    // if (pages.length > 0) {
    //   console.log('Fix error of wrong silex type for', pages.length, 'pages');
    //   pages.forEach((page) => page.setAttribute(Constants.TYPE_ATTR, Constants.TYPE_PAGE));
    // }
  }

  /**
   * update the static scripts to match the current server and latest version
   */
  updateStatic(doc) {
    // update //{{host}}/2.x/... to latest version
    const elements = doc.querySelectorAll('[data-silex-static]')
    for (const element of elements) {
      const propName = element.src ? 'src' : 'href'
      const newUrl = this.getStaticResourceUrl(element[propName])
      const oldUrl = element.getAttribute(propName)
      if (oldUrl !== newUrl) {
        element.setAttribute(propName, newUrl)
      }
    }
  }

  /**
   * get the complete URL for the static file,
   * * on the current Silex server
   * * with the latest Silex version
   *
   * this will result in a URL on the current server, in the `/static/` folder
   *
   * @example `//localhost:6805/static/2.1/example/example.js` returns `//editor.silex.me/static/2.7/example/unslider.js`
   * @example `/static/2.1/example/example.js` returns `//editor.silex.me/static/2.7/example/example.js`
   *
   * with the current version
   * @param {string} url
   * @return {string}
   */
  getStaticResourceUrl(url) {
    const pathRelativeToStaticMatch = url.match(/static\/[0-9]*\.[0-9]*\/(.*)/)
    if (pathRelativeToStaticMatch == null) {
      console.warn('Error: could not extract the path and file name of static asset', url)
      return url
    }
    const pathRelativeToStatic = pathRelativeToStaticMatch[1]
    return `${ this.rootUrl }/static/${ this.frontEndVersion[0] }.${ this.frontEndVersion[1] }/${ pathRelativeToStatic }`
  }

  /**
   * check if the website has been edited with a newer version of Silex
   * @param {Array.<number>} initialVersion the website version
   * @param {Array.<number>} targetVersion  a given Silex version
   * @return {boolean}
   */
  amIObsolete(initialVersion, targetVersion) {
    return !!initialVersion[2] && initialVersion[0] > targetVersion[0] ||
      initialVersion[1] > targetVersion[1] ||
      initialVersion[2] > targetVersion[2]
  }

  /**
   * check if the website has to be updated for the given version of Silex
   * @param {Array.<number>} initialVersion the website version
   * @param {Array.<number>} targetVersion  a given Silex version
   * @return {boolean}
   */
  hasToUpdate(initialVersion, targetVersion) {
    return initialVersion[0] < targetVersion[0] ||
      initialVersion[1] < targetVersion[1] ||
      initialVersion[2] < targetVersion[2]
    }

    to2_2_8(version, doc): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const actions = []
        if (this.hasToUpdate(version, [2, 2, 8])) {
          // cleanup the hamburger menu icon
          const menuButton = doc.querySelector('.menu-button')
          if (menuButton) {
            menuButton.classList.remove('paged-element', 'paged-element-hidden', 'page-page-1', 'prevent-resizable')
            menuButton.classList.add('hide-on-desktop')
          }
          // give the hamburger menu a size (TODO: add to the json model too)
          doc.querySelector('.silex-inline-styles').innerHTML += '.silex-id-hamburger-menu {width: 50px;min-height: 40px;}'
          // pages need to have href set
          Array.from(doc.querySelectorAll('.page-element'))
          .forEach((el: HTMLLinkElement) => {
            el.setAttribute('href', '#!' + el.getAttribute('id'))
          })
          actions.push('I fixed the mobile menu so that it is compatible with the new publication (now multiple pages are generated instead of 1 single page for the whole website).')
        }
        resolve(actions)
      })
    }

    to2_2_9(version, doc): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const actions = []
        if (this.hasToUpdate(version, [2, 2, 9])) {
          // remove the hamburger menu icon
          const menuButton = doc.querySelector('.menu-button')
          if (menuButton) {
            menuButton.parentElement.removeChild(menuButton)
            actions.push(
              'I removed the mobile menu as there is now a component for that. <a target="_blank" href="https://github.com/silexlabs/Silex/wiki/Hamburger-menu">Read more about the Hamburger Menu component here</a>.',
            )
          }
        }
        resolve(actions)
      })
    }

    to2_2_10(version, doc): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const actions = []
        if (this.hasToUpdate(version, [2, 2, 10])) {
          // the body is a drop zone, not selectable, not draggable, resizeable
          doc.body.classList.add(
            Constants.PREVENT_DRAGGABLE_CLASS_NAME,
            Constants.PREVENT_RESIZABLE_CLASS_NAME,
            Constants.PREVENT_SELECTABLE_CLASS_NAME)

          // each section background and foreground is a drop zone, not selectable, not draggable, resizeable
          const changedSections = Array.from(doc.querySelectorAll(`.${ElementType.SECTION}`)) as HTMLElement[]
          changedSections.forEach((el: HTMLElement) => el.classList.add(
            Constants.PREVENT_DRAGGABLE_CLASS_NAME,
            Constants.PREVENT_RESIZABLE_CLASS_NAME,
          ))

          // we add classes to the elements so that we can tell the stage component if an element is draggable, resizeable, selectable...
          const changedSectionsContent = Array.from(doc.querySelectorAll(`.${ElementType.SECTION}, .${ElementType.SECTION} .${SECTION_CONTAINER}`))
          changedSectionsContent.forEach((el: HTMLElement) => el.classList.add(
            Constants.PREVENT_DRAGGABLE_CLASS_NAME,
            // Constants.PREVENT_RESIZABLE_LEFT_CLASS_NAME,
            // Constants.PREVENT_RESIZABLE_RIGHT_CLASS_NAME
          ))
          actions.push(`Changed the body and ${changedSections.length} sections with new CSS classes to <a href="https://github.com/silexlabs/stage/" target="_blank">the new stage component.</a>`)

          // types are now with a "-element" suffix
          const changedElements = Array.from(doc.querySelectorAll(`[${Constants.TYPE_ATTR}]`))
          changedElements.forEach((el: HTMLElement) => el.setAttribute(Constants.TYPE_ATTR, el.getAttribute(Constants.TYPE_ATTR) + '-element'))

          actions.push(`Updated ${ changedElements.length } elements, changed their types to match the new version of Silex.`)
        }
        resolve(actions)
      })
    }

    to2_2_11(version, doc): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const actions = []
        if (this.hasToUpdate(version, [2, 2, 11])) {
          // the body is supposed to be an element too
          doc.body.classList.add(Constants.EDITABLE_CLASS_NAME)
          actions.push('I made the body editable.')

          // import elements
          const elements = getElementsFromDomBC(doc)
          writeStyles(doc, elements)

          // site
          const site = getSiteFromDom(doc)
          writeSiteStyles(doc, site)

          // pages
          const pages = getPagesFromDom(doc)

          if (elements.length && pages.length && site) {
            this.data = {
              site,
              pages,
              elements,
            }
            this.removeIfExist(doc, 'meta[name="website-width"]')
            this.removeIfExist(doc, 'meta[name="hostingProvider"]')
            this.removeIfExist(doc, 'meta[name="publicationPath"]');

            ['prevent-draggable', SECTION_CONTAINER].forEach((className) => this.removeUselessCSSClass(doc, className))

            actions.push('I updated the model to the latest version of Silex.')
            // pages
            this.removeIfExist(doc, `.${Constants.PAGES_CONTAINER_CLASS_NAME}`)
            actions.push('I removed the old pages system.')
          } else {
            console.error('Could not import site from v2.2.11', {elements, pages, site})
          }
        }
        resolve(actions)
      })
    }
}
