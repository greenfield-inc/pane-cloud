# One VPC with a public subnet per zone and no NAT gateway. Hosts and the controller get a public
# IPv4 address for egress only; their security groups admit nothing from the internet. README.md
# explains why this beats private subnets behind NAT for this fleet.
resource "aws_vpc" "fleet" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "fleet" {
  vpc_id = aws_vpc.fleet.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "fleet" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.fleet.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-${var.availability_zones[count.index]}" }
}

resource "aws_route_table" "fleet" {
  vpc_id = aws_vpc.fleet.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.fleet.id
  }
  tags = { Name = var.name }
}

resource "aws_route_table_association" "fleet" {
  count          = length(aws_subnet.fleet)
  subnet_id      = aws_subnet.fleet[count.index].id
  route_table_id = aws_route_table.fleet.id
}

# The VPC's default security group gets no rules, so nothing launched without a group is reachable.
resource "aws_default_security_group" "fleet" {
  vpc_id = aws_vpc.fleet.id
}

# Fleet hosts: no inbound rules at all. Host agents dial the controller; nothing dials a host.
resource "aws_security_group" "host" {
  name        = "${var.name}-host"
  description = "Fleet hosts: no inbound, any outbound"
  vpc_id      = aws_vpc.fleet.id
}

resource "aws_vpc_security_group_egress_rule" "host_all" {
  security_group_id = aws_security_group.host.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The service (S1) runs in this group wherever it is deployed in the VPC.
resource "aws_security_group" "service" {
  name        = "${var.name}-service"
  description = "Pane Cloud service: no inbound from here, any outbound"
  vpc_id      = aws_vpc.fleet.id
}

resource "aws_vpc_security_group_egress_rule" "service_all" {
  security_group_id = aws_security_group.service.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The controller accepts the fleet API port from the service and from hosts, and nothing else.
resource "aws_security_group" "controller" {
  name        = "${var.name}-controller"
  description = "Fleet controller: fleet API from the service and hosts only"
  vpc_id      = aws_vpc.fleet.id
}

resource "aws_vpc_security_group_ingress_rule" "controller_from_service" {
  security_group_id            = aws_security_group.controller.id
  referenced_security_group_id = aws_security_group.service.id
  ip_protocol                  = "tcp"
  from_port                    = var.fleet_api_port
  to_port                      = var.fleet_api_port
}

resource "aws_vpc_security_group_ingress_rule" "controller_from_hosts" {
  security_group_id            = aws_security_group.controller.id
  referenced_security_group_id = aws_security_group.host.id
  ip_protocol                  = "tcp"
  from_port                    = var.fleet_api_port
  to_port                      = var.fleet_api_port
}

resource "aws_vpc_security_group_egress_rule" "controller_all" {
  security_group_id = aws_security_group.controller.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
