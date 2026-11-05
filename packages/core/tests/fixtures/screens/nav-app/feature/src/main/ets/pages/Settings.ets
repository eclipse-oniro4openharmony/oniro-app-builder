const URL_RE = /https?:\/\/[^/]+\/{1}/i;

@Builder
export function SettingsBuilder() {
  SettingsPage()
}

@Component
struct SettingsPage {
  pathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      List() {
        ListItem() { Toggle({ type: ToggleType.Switch, isOn: true }) }
        ListItem() { Text('Theme // not a comment') }
      }
      Button('Detail').onClick(() => this.pathStack.pushPath(new NavPathInfo('Detail', null)))
      Text(`/* not a comment */ ${this.pathStack.size()} open`)
    }
    .onReady((ctx: NavDestinationContext) => { this.pathStack = ctx.pathStack })
  }
}
