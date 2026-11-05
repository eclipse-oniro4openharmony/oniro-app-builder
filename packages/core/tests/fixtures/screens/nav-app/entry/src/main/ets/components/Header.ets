@Builder
export function Badge(n: number) {
  Text(n.toString())
}

@Component
export struct Header {
  @Prop title: string = '';

  build() {
    Row() {
      Text(this.title)
      Image($r('app.media.startIcon')).width(24)
        .onClick(() => {
          this.getUIContext().getRouter().replaceUrl({ url: 'pages/About' });
        })
    }
  }
}

@Component
export struct Spacer {
  build() {}
}
