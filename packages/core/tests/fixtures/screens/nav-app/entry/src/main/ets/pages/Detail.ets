@ComponentV2
export struct DetailPage {
  @Require @Param id: string = '';
  stack: NavPathStack = new NavPathStack();
  private next: string = 'Settings';
  @Local target: string = '';

  build() {
    NavDestination() {
      Text(this.id)
      Text(`Item ${this.id}`)
      if (this.id.length > 0) {
        Button('Settings').onClick(() => this.stack.pushPathByName(this.next, null))
      } else {
        Text('No item')
      }
      Button('Dynamic').onClick(() => this.stack.replacePathByName(this.target + 'x', null))
      Button('Back').onClick(() => this.stack.pop())
    }
    .title('Detail')
    .onReady((ctx: NavDestinationContext) => { this.stack = ctx.pathStack; })
  }
}
