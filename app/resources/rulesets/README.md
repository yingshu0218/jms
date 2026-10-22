# 内置大陆 IP 规则

来源：SagerNet/sing-geoip，固定修订 eb32cd6ed4a16fcb3bf9a36ccebf28e45716ae84。
URL：https://raw.githubusercontent.com/SagerNet/sing-geoip/eb32cd6ed4a16fcb3bf9a36ccebf28e45716ae84/geoip-cn.srs
SHA256：81ada5cafd9d831adc48776f29cdfe55c9713d9287caeef9de925ef30f66cce4
上游许可证见 LICENSE，打包时随应用分发。

engine/bundled-geoip.json 内嵌相同二进制及来源校验信息，由 sidecar 构建器打包。
首次启动离线写入用户数据目录 rulesets/；一周后尝试更新，下载失败继续使用旧库。
地域按上游 IP 数据判定，不能保证实时地理位置。域名规则在线缓存，失败使用有限后缀兜底。
不会修改用户自定义规则，既有全局模式不自动改成规则模式。
