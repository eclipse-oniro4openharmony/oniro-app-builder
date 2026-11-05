@Entry({ routeName: 'shared/Named' })
@Component
export struct Named {
  build() {
    Column() {
      Text('Named route page')
    }
  }
}

@Entry
@Component
struct Unlisted {
  build() {
    Column() {
      Text('Not in main_pages')
    }
  }
}
