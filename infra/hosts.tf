# Fleet hosts: r7g.metal from the F1 image, no inbound, IMDSv2 with hop limit 1 (so a guest routed
# through the host cannot reach the host's credentials), and a data volume that outlives the host.
resource "aws_launch_template" "host" {
  name                   = "${var.name}-host"
  image_id               = var.host_ami_id
  instance_type          = var.host_instance_type
  vpc_security_group_ids = [aws_security_group.host.id]
  update_default_version = true

  iam_instance_profile {
    arn = aws_iam_instance_profile.host.arn
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = 30
      encrypted             = true
      delete_on_termination = true
    }
  }

  # The data volume (F1's fleet-data label, formatted by host-boot.sh on first boot). It survives
  # the host, so a replacement host can attach it and boot the lost host's machines from their disks.
  block_device_mappings {
    device_name = "/dev/sdf"
    ebs {
      volume_type           = "gp3"
      volume_size           = var.data_volume_gib
      iops                  = var.data_volume_iops
      throughput            = var.data_volume_throughput
      encrypted             = true
      delete_on_termination = false
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-host", (local.component_tag) = "fleet-host", "pane-cloud:fleet" = var.name }
  }

  # Provider default_tags do not reach tag_specifications, so the fleet tag is set here. Launch
  # templates tag every volume alike. The root volume is deleted with its host; the data
  # volume carries the tag the host role's attach permission requires.
  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.name}-host-data", (local.component_tag) = "fleet-data", "pane-cloud:fleet" = var.name }
  }
}

resource "aws_autoscaling_group" "hosts" {
  name                      = "${var.name}-hosts"
  min_size                  = var.host_count
  max_size                  = var.host_count
  desired_capacity          = var.host_count
  vpc_zone_identifier       = aws_subnet.fleet[*].id
  health_check_type         = "EC2"
  health_check_grace_period = 600

  launch_template {
    id      = aws_launch_template.host.id
    version = aws_launch_template.host.latest_version
  }
}

# The fleet controller runs the F2 fleet API and scheduler. One t4g.micro in an Auto Scaling group
# of one, so AWS replaces it if it dies. See README.md for why this is the smallest option.
resource "aws_launch_template" "controller" {
  name                   = "${var.name}-controller"
  image_id               = var.controller_ami_id
  instance_type          = var.controller_instance_type
  vpc_security_group_ids = [aws_security_group.controller.id]
  update_default_version = true

  iam_instance_profile {
    arn = aws_iam_instance_profile.controller.arn
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-controller", (local.component_tag) = "fleet-controller", "pane-cloud:fleet" = var.name }
  }
}

resource "aws_autoscaling_group" "controller" {
  name                = "${var.name}-controller"
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1
  vpc_zone_identifier = aws_subnet.fleet[*].id
  health_check_type   = "EC2"

  launch_template {
    id      = aws_launch_template.controller.id
    version = aws_launch_template.controller.latest_version
  }
}
